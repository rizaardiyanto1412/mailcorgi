import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInstall, expectError, type Install, type Client } from './harness.ts'

const tokenFor = (install: Install, email: string) => {
  const mail = install.outbox().filter((m) => m.to_email === email && m.text.includes('/invite?token=')).at(-1)
  assert.ok(mail, `No invitation email for ${email}`)
  const match = /\/invite\?token=([^\s]+)/.exec(mail.text)
  assert.ok(match)
  return decodeURIComponent(match[1])
}
const select = async (client: Client, accountId: string) => { await client.post('/api/auth/account', { accountId }); await client.refresh() }

test('newsletter teams isolate grants, change roles, revoke sessions immediately, and let members leave', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'member@example.com,admin@example.com,outsider@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const member = await install.signUp({ email: 'member@example.com' })
    const admin = await install.signUp({ email: 'admin@example.com' })
    const outsider = await install.signUp({ email: 'outsider@example.com' })
    const a = await owner.action('newsletters.create', { name: 'Shared weekly' })
    const b = await owner.action('newsletters.create', { name: 'Private weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: a.id }
    for (const [client, role] of [[member, 'member'], [admin, 'admin']] as const) {
      await owner.action('team.invite', { ...scope, email: client.email, role })
      await client.action('team.accept', { token: tokenFor(install, client.email) })
      await select(client, scope.accountId)
      assert.equal(client.session.accounts.find((v) => v.id === scope.accountId)?.grants[a.id], role)
      assert.deepEqual((await client.action('newsletters.list', {})).newsletters.map((n) => n.id), [a.id])
      assert.equal((await client.actionRaw('newsletters.get', { newsletterId: b.id })).status, 403)
      assert.equal((await client.actionRaw('team.invite', { ...scope, email: 'no@example.com', role: 'member' })).status, 404)
      assert.equal((await client.actionRaw('team.list', scope)).status, 404)
    }
    const ownAndShared = await member.action('team.newsletters', {})
    assert.equal(ownAndShared.accounts.find((g) => g.id === scope.accountId)?.owner, false)
    assert.deepEqual(ownAndShared.accounts.find((g) => g.id === scope.accountId)?.newsletters, [{ id: a.id, name: a.name }])
    assert.equal((await outsider.action('team.newsletters', {})).accounts.some((g) => g.id === scope.accountId), false)
    assert.equal((await outsider.fetch('/api/auth/account', { method: 'POST', body: JSON.stringify({ accountId: scope.accountId }) })).status, 404)
    const draft = await member.action('campaigns.create', { newsletterId: a.id, subject: 'Member draft' })
    await member.action('campaigns.update', { campaignId: draft.id, revision: draft.revision, subject: 'Edited by a member' })
    assert.equal((await member.actionRaw('newsletters.update', { newsletterId: a.id, name: 'Blocked' })).status, 403)
    await admin.action('newsletters.update', { newsletterId: a.id, description: 'Admin setting' })
    const hiddenDraft = await owner.action('campaigns.create', { newsletterId: b.id })
    const hiddenContact = await owner.action('contacts.create', { newsletterId: b.id, email: 'hidden@example.com' })
    const hiddenSegment = await owner.action('segments.create', { newsletterId: b.id, name: 'Private', filter: { field: 'status', in: ['subscribed'] } })
    const hiddenAuthor = await owner.action('authors.create', { newsletterId: b.id, name: 'Private author', slug: 'private' })
    const hiddenTag = await owner.action('tags.create', { newsletterId: b.id, name: 'Private tag' })
    for (const [name, input] of [
      ['campaigns.get', { campaignId: hiddenDraft.id }],
      ['contacts.get', { newsletterId: b.id, contactId: hiddenContact.contact.id }],
      ['contacts.get', { newsletterId: a.id, contactId: hiddenContact.contact.id }],
      ['segments.update', { newsletterId: a.id, segmentId: hiddenSegment.id, name: 'Stolen', filter: { field: 'status', in: ['subscribed'] } }],
      ['authors.update', { newsletterId: a.id, authorId: hiddenAuthor.id, name: 'Stolen', slug: 'stolen' }],
      ['tags.update', { newsletterId: a.id, tagId: hiddenTag.id, name: 'Stolen' }],
    ] as const) assert.ok([403, 404].includes((await member.actionRaw(name, input)).status), name)
    await owner.action('team.changeRole', { ...scope, userId: member.session.user.id, role: 'admin' })
    await member.action('newsletters.update', { newsletterId: a.id, description: 'New admin' })
    await owner.action('team.changeRole', { ...scope, userId: member.session.user.id, role: 'member' })
    assert.equal((await member.actionRaw('newsletters.update', { newsletterId: a.id, description: 'Old admin' })).status, 403)
    const secondSession = await install.signIn(member.email, 'correct horse battery')
    await select(secondSession, scope.accountId)
    await owner.action('team.remove', { ...scope, userId: member.session.user.id })
    install.clock.advance(30_001)
    for (const client of [member, secondSession]) {
      await client.refresh()
      assert.equal(client.session.accounts.some((a) => a.id === scope.accountId), false)
      assert.equal((await client.actionRaw('campaigns.get', { campaignId: draft.id })).status, 404)
    }
    await admin.action('team.leave', scope)
    await admin.refresh()
    assert.equal(admin.session.accounts.some((a) => a.id === scope.accountId), false)
    assert.equal((await owner.actionRaw('team.leave', scope)).status, 403)
    assert.equal((await owner.action('team.list', scope)).members.length, 0)
  } finally { install.close() }
})

test('invites use hashed, expiring, single-use tokens and reject a wrong account, resend and revoke', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'invitee@example.com,wrong@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const guest = await install.signUp({ email: 'invitee@example.com' })
    const wrong = await install.signUp({ email: 'wrong@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Token weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }
    const invitation = await owner.action('team.invite', { ...scope, email: ' INVITEE@EXAMPLE.COM ', role: 'member' })
    const first = tokenFor(install, guest.email)
    const stored = install.app.control.ctx.db.get<{ token_hash: string }>('SELECT token_hash FROM invites WHERE id = ?', invitation.id)!
    assert.notEqual(stored.token_hash, first)
    assert.match(stored.token_hash, /^[a-f0-9]{64}$/)
    assert.equal((await wrong.actionRaw('team.accept', { token: first })).status, 403)
    assert.equal((await owner.actionRaw('team.resend', { ...scope, inviteId: invitation.id })).status, 429)
    install.clock.advance(60_001)
    await owner.action('team.resend', { ...scope, inviteId: invitation.id })
    const second = tokenFor(install, guest.email)
    assert.notEqual(second, first)
    assert.equal((await guest.actionRaw('team.accept', { token: first })).status, 410)
    const results = await Promise.all([guest.actionRaw('team.accept', { token: second }), guest.actionRaw('team.accept', { token: second })])
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 410])
    assert.equal((await owner.action('team.list', scope)).members.length, 1)
    assert.equal((await guest.actionRaw('team.accept', { token: second })).status, 410)
    await owner.action('team.remove', { ...scope, userId: guest.session.user.id })
    const revoked = await owner.action('team.invite', { ...scope, email: guest.email, role: 'admin' })
    const revokedToken = tokenFor(install, guest.email)
    await owner.action('team.revoke', { ...scope, inviteId: revoked.id })
    assert.equal((await guest.actionRaw('team.accept', { token: revokedToken })).status, 410)
    await owner.action('team.invite', { ...scope, email: guest.email, role: 'member' })
    const expired = tokenFor(install, guest.email)
    install.clock.advance(7 * 86_400_000)
    assert.equal((await guest.actionRaw('team.accept', { token: expired })).status, 410)
    assert.equal((await owner.action('team.list', scope)).invites.length, 0)
    assert.equal((await guest.actionRaw('team.accept', { token: 'x'.repeat(32) })).status, 410)
  } finally { install.close() }
})

test('a valid invite permits signup on a closed self-hosted install without granting another email access', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Closed weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }
    await owner.action('team.invite', { ...scope, email: 'new@example.com', role: 'member' })
    const token = tokenFor(install, 'new@example.com')
    const signup = (email: string, inviteToken?: string) => install.fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'New person', email, password: 'correct horse battery', inviteToken }) })
    assert.equal((await signup('new@example.com')).status, 403)
    assert.equal((await signup('wrong@example.com', token)).status, 403)
    const response = await signup('new@example.com', token)
    assert.equal(response.status, 200)
    const cookie = response.headers.getSetCookie().map((s) => s.split(';')[0]).join('; ')
    const guest = await install.clientFromCookie(cookie)
    await guest.action('team.accept', { token })
    await select(guest, scope.accountId)
    assert.equal((await guest.action('newsletters.get', { newsletterId: nl.id })).name, nl.name)
    assert.equal((await signup('new@example.com', token)).status, 410)
  } finally { install.close() }
})

test('cloud plan counts pending and accepted seats atomically', async () => {
  const install = await createInstall({ cloud: true })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const guest = await install.signUp({ email: 'guest@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Cloud weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }
    await owner.action('team.invite', { ...scope, email: guest.email, role: 'admin' })
    const token = tokenFor(install, guest.email)
    await guest.action('team.accept', { token })
    const pending = await owner.action('team.invite', { ...scope, email: 'pending@example.com', role: 'member' })
    assert.equal((await expectError(() => owner.action('team.invite', { ...scope, email: 'extra@example.com', role: 'member' }))).code, 'limit_reached')
    await owner.action('team.revoke', { ...scope, inviteId: pending.id })
    const attempts = await Promise.all(['one@example.com', 'two@example.com'].map((email) => owner.actionRaw('team.invite', { ...scope, email, role: 'member' })))
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 403])
    assert.equal((await owner.actionRaw('team.invite', { ...scope, email: guest.email, role: 'member' })).status, 409)
    assert.equal((await owner.actionRaw('team.invite', { ...scope, email: owner.email, role: 'member' })).status, 409)
    assert.equal((await owner.actionRaw('team.invite', { ...scope, newsletterId: 'missing', email: 'x@example.com', role: 'member' })).status, 404)
  } finally { install.close() }
})


test('acceptance rechecks plan downgrades and permits a cloud invite signup while ordinary signup is closed', async () => {
  const install = await createInstall({ cloud: true })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Downgrade weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }
    const db = install.app.control.ctx.db
    db.run('UPDATE accounts SET plan = ? WHERE id = ?', 'starter', scope.accountId)
    db.run('INSERT INTO install_settings (key, value) VALUES (?, ?)', 'signup_mode', 'closed')
    const invitations = []
    for (const email of ['new@example.com', 'two@example.com', 'three@example.com']) invitations.push(await owner.action('team.invite', { ...scope, email, role: 'member' }))
    const token = tokenFor(install, 'new@example.com')
    const response = await install.fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cloud guest', email: 'new@example.com', password: 'correct horse battery', inviteToken: token }) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).pending, true)
    assert.equal(response.headers.getSetCookie().length, 0)
    const verified = await install.fetch('/api/auth/signup/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new@example.com', code: install.lastCode('new@example.com') }) })
    assert.equal(verified.status, 200)
    const guest = await install.clientFromCookie(verified.headers.getSetCookie().map((s) => s.split(';')[0]).join('; '))
    db.run('UPDATE accounts SET plan = ? WHERE id = ?', 'free', scope.accountId)
    assert.equal((await guest.actionRaw('team.accept', { token })).status, 403)
    await owner.action('team.revoke', { ...scope, inviteId: invitations[2].id })
    await guest.action('team.accept', { token })
    assert.equal((await owner.action('team.list', scope)).members.length, 1)
  } finally { install.close() }
})

test('delivery failure leaves a retryable invite and rate limits survive revocation', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Email weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }
    const db = install.app.control.ctx.db
    db.run('INSERT INTO install_settings (key, value) VALUES (?, ?)', 'sending_enabled', 'false')
    assert.equal((await owner.action('team.invite', { ...scope, email: 'guest@example.com', role: 'member' })).emailed, false)
    const saved = (await owner.action('team.list', scope)).invites[0]
    assert.ok(saved)
    assert.equal(install.outbox().some((m) => m.to_email === 'guest@example.com'), false)
    db.run('UPDATE install_settings SET value = ? WHERE key = ?', 'true', 'sending_enabled')
    install.clock.advance(60_001)
    await owner.action('team.resend', { ...scope, inviteId: saved.id })
    assert.ok(tokenFor(install, 'guest@example.com'))
    await owner.action('team.revoke', { ...scope, inviteId: saved.id })
    for (let n = 0; n < 3; n++) {
      const invite = await owner.action('team.invite', { ...scope, email: 'guest@example.com', role: 'member' })
      await owner.action('team.revoke', { ...scope, inviteId: invite.id })
    }
    assert.equal((await expectError(() => owner.action('team.invite', { ...scope, email: 'guest@example.com', role: 'member' }))).code, 'rate_limited')
    install.clock.advance(86_400_000)
    await owner.action('team.invite', { ...scope, email: 'guest@example.com', role: 'member' })
  } finally { install.close() }
})
