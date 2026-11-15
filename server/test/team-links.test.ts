import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_URL, createInstall } from './harness.ts'

const tokenOf = (link: string) => decodeURIComponent(new URL(link).searchParams.get('token') ?? '')

test('the owner gets a copyable invite link once, in the invite and resend responses', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'guest@example.com,other@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const other = await install.signUp({ email: 'other@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Linked weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }

    const created = await owner.action('team.invite', { ...scope, email: 'guest@example.com', role: 'member' })
    assert.ok(created.link.startsWith(`${APP_URL}/invite?token=`), created.link)
    assert.equal(created.emailed, true)
    const list = await owner.action('team.list', scope)
    assert.equal(list.emailConfigured, false, 'the built-in test provider sends nothing')
    assert.ok(!JSON.stringify(list).includes(tokenOf(created.link)), 'the list never carries the link')
    const stored = install.app.control.ctx.db.get<{ token_hash: string }>('SELECT token_hash FROM invites WHERE id = ?', created.id)!
    assert.notEqual(stored.token_hash, tokenOf(created.link), 'tokens stay hashed at rest')

    assert.equal((await other.actionRaw('team.invite', { ...scope, email: 'x@example.com', role: 'member' })).status >= 403, true)
    assert.equal((await other.actionRaw('team.resend', { ...scope, inviteId: created.id })).status >= 403, true)

    install.clock.advance(60_001)
    const resent = await owner.action('team.resend', { ...scope, inviteId: created.id })
    assert.notEqual(tokenOf(resent.link), tokenOf(created.link))
    const guest = await install.signUp({ email: 'guest@example.com' })
    assert.equal((await guest.actionRaw('team.accept', { token: tokenOf(created.link) })).status, 410)
    assert.deepEqual(await guest.action('team.accept', { token: tokenOf(resent.link) }), scope)
  } finally {
    install.close()
  }
})

test('an invite whose email fails still returns the link to share by hand', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Quiet weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }
    install.app.control.ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?)', 'sending_enabled', 'false')
    const invite = await owner.action('team.invite', { ...scope, email: 'guest@example.com', role: 'admin' })
    assert.equal(invite.emailed, false)
    assert.ok(invite.link.includes('/invite?token='))
    assert.equal(install.outbox().some((m) => m.to_email === 'guest@example.com'), false)
  } finally {
    install.close()
  }
})

test('the team page and the sign-up page know when no real email provider is configured', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'friend@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Provider weekly' })
    const scope = { accountId: owner.accountId!, newsletterId: nl.id }
    const boot = async () => (await install.fetch('/api/auth/bootstrap')).json()
    const before = await boot()
    assert.equal(before.signupOpen, false, 'an allowlist without email is sign-up by invitation')
    assert.deepEqual(Object.keys(before).sort(), ['appUrl', 'cloud', 'session', 'setupRequired', 'signupOpen'], 'nothing about the provider reaches visitors')
    install.app.control.ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?)', 'email_provider', 'smtp')
    assert.equal((await boot()).signupOpen, true)
    assert.equal((await owner.action('team.list', scope)).emailConfigured, true)
  } finally {
    install.close()
  }
})
