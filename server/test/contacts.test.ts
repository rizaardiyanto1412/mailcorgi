import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError } from './harness.ts'
import { subscribe, suppress, isSuppressed, setContactStatus } from '../account/contacts/index.ts'
import { sha256Hex } from '../core/crypto.ts'
import { emailHash } from '../account/contacts/hash.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'

const localInstall = () => createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })

test('contact lifecycle, tombstones, confirmed consent and newsletter isolation', async () => {
  const install = await localInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const a = await owner.action('newsletters.create', { name: 'Alpha' })
    const b = await owner.action('newsletters.create', { name: 'Bravo' })
    const ctx = install.app.account(owner.accountId!).ctx
    const created = await owner.action('contacts.create', { newsletterId: a.id, email: ' PERSON@example.com ', name: 'Person' })
    assert.equal(created.contact.email, 'person@example.com')
    assert.equal(created.outcome, 'subscribed')
    assert.equal((await owner.action('contacts.create', { newsletterId: a.id, email: 'person@example.com' })).outcome, 'exists')
    const other = subscribe(ctx, { newsletterId: b.id, email: 'person@example.com', source: 'test', consent: 'asserted' })
    await owner.action('contacts.unsubscribe', { newsletterId: a.id, contactId: created.contact.id, reason: 'Not now' })
    assert.equal((await owner.action('contacts.create', { newsletterId: a.id, email: 'person@example.com' })).outcome, 'suppressed')
    assert.equal(subscribe(ctx, { newsletterId: a.id, email: 'person@example.com', source: 'signup', consent: 'pending' }).outcome, 'suppressed')
    assert.equal((await owner.action('contacts.get', { newsletterId: b.id, contactId: other.contact.id })).contact.status, 'subscribed')
    assert.equal(subscribe(ctx, { newsletterId: a.id, email: 'person@example.com', source: 'signup', consent: 'confirmed' }).outcome, 'subscribed')
    await owner.action('contacts.delete', { newsletterId: a.id, contactId: created.contact.id })
    assert.equal((await owner.action('contacts.create', { newsletterId: a.id, email: 'person@example.com' })).outcome, 'suppressed')
    const revived = subscribe(ctx, { newsletterId: a.id, email: 'person@example.com', source: 'signup', consent: 'confirmed' })
    assert.equal(revived.created, true)
    assert.equal(revived.contact.status, 'subscribed')
    assert.notEqual(revived.contact.id, created.contact.id)
    const pending = subscribe(ctx, { newsletterId: a.id, email: 'pending@example.com', source: 'signup', consent: 'pending' })
    assert.equal(pending.contact.status, 'unconfirmed')
    assert.equal(subscribe(ctx, { newsletterId: a.id, email: 'pending@example.com', source: 'signup', consent: 'confirmed' }).contact.confirmedAt, install.clock.now())
    const before = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n
    setContactStatus(ctx, pending.contact.id, 'subscribed')
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n, before)
    suppress(ctx, { email: 'person@example.com', newsletterId: null, reason: 'hard_bounce' })
    assert.equal((await owner.action('contacts.get', { newsletterId: b.id, contactId: other.contact.id })).contact.status, 'bounced')
    assert.equal(subscribe(ctx, { newsletterId: a.id, email: 'person@example.com', source: 'signup', consent: 'confirmed' }).outcome, 'suppressed')
    assert.equal(isSuppressed(ctx, 'person@example.com', b.id), true)
    const timeline = await owner.action('contacts.get', { newsletterId: a.id, contactId: pending.contact.id })
    assert.deepEqual(timeline.events.map((e) => e.type), ['confirm', 'signup'])
    assert.equal(ctx.db.get<{ subscribed: number }>('SELECT subscribed FROM daily_stats WHERE newsletter_id = ?', a.id)!.subscribed, 4)
    assert.equal(emailHash('person@example.com'), await sha256Hex('person@example.com'))
  } finally { install.close() }
})

test('contact limits are atomic and no-op on the N+1th subscriber', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Limit test' })
    await install.app.stores.account(owner.accountId!).applyPolicy({ version: 2, status: 'active', plan: 'test', limits: { maxContacts: 2, maxEmailsPerMonth: 5, maxNewsletters: 3, maxTeamPerNewsletter: 2 } })
    const ctx = install.app.account(owner.accountId!).ctx
    const first = await owner.action('contacts.create', { newsletterId: nl.id, email: 'first@example.com' })
    subscribe(ctx, { newsletterId: nl.id, email: 'second@example.com', source: 'signup', consent: 'pending' })
    const before = ctx.db.all('SELECT * FROM events')
    const jobs = ctx.db.all('SELECT * FROM jobs')
    assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: 'third@example.com' })).outcome, 'limit')
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts')!.n, 2)
    assert.deepEqual(ctx.db.all('SELECT * FROM events'), before)
    assert.deepEqual(ctx.db.all('SELECT * FROM jobs'), jobs)
    await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: first.contact.id })
    assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: 'third@example.com' })).outcome, 'subscribed')
    assert.equal(subscribe(ctx, { newsletterId: nl.id, email: 'first@example.com', source: 'signup', consent: 'confirmed' }).outcome, 'limit')
    assert.equal(isSuppressed(ctx, 'first@example.com', nl.id), true)
  } finally { install.close() }
})

test('newsletter resource ids, bulk inputs and tags cannot bypass permissions', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const a = await owner.action('newsletters.create', { name: 'Alpha' })
    const b = await owner.action('newsletters.create', { name: 'Bravo' })
    const ctx = install.app.account(owner.accountId!).ctx
    const ca = (await owner.action('contacts.create', { newsletterId: a.id, email: 'a@example.com' })).contact
    const cb = (await owner.action('contacts.create', { newsletterId: b.id, email: 'b@example.com' })).contact
    const actor: Actor = { userId: 'member', email: 'member@example.com', owner: false, grants: { [a.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
    const rejects = (name: string, input: unknown, status: number) => assert.rejects(runAction(ctx, name, input, actor), (e: unknown) => e instanceof AppError && e.status === status)
    await rejects('contacts.list', { newsletterId: b.id }, 403)
    await rejects('contacts.get', { newsletterId: a.id, contactId: cb.id }, 404)
    await rejects('contacts.get', { newsletterId: b.id, contactId: cb.id }, 403)
    await rejects('contacts.update', { newsletterId: a.id, contactId: ca.id, name: 'No' }, 403)
    actor.grants[a.id] = 'admin'
    await rejects('contacts.update', { newsletterId: a.id, contactId: cb.id, name: 'No' }, 404)
    const tag = await owner.action('tags.create', { newsletterId: b.id, name: 'Secret' })
    await rejects('contacts.bulk', { newsletterId: a.id, contactIds: [ca.id, cb.id], operation: 'delete' }, 404)
    await rejects('contacts.bulk', { newsletterId: a.id, contactIds: [ca.id], operation: 'tag', tagIds: [tag.id] }, 404)
    assert.equal((await owner.action('contacts.get', { newsletterId: a.id, contactId: ca.id })).contact.name, '')
    await rejects('tags.update', { newsletterId: a.id, tagId: tag.id, name: 'No' }, 404)
    actor.access = 'read'
    await rejects('contacts.delete', { newsletterId: a.id, contactId: ca.id }, 403)
    assert.equal((await expectError(() => owner.action('contacts.get', { newsletterId: a.id, contactId: 'missing' }))).status, 404)
  } finally { install.close() }
})

test('typed fields, tags, bulk operations, keyset paging and formula-safe export', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Contacts test' })
    const newsletterId = nl.id
    const tag = await owner.action('tags.create', { newsletterId, name: 'Readers' })
    const countField = await owner.action('contactFields.create', { newsletterId, key: 'count', label: 'Count', type: 'number' })
    await owner.action('contactFields.create', { newsletterId, key: 'birthday', label: 'Birthday', type: 'date' })
    assert.equal((await expectError(() => owner.action('contacts.create', { newsletterId, email: 'bad@example.com', fields: { count: 'one' } }))).status, 400)
    const a = (await owner.action('contacts.create', { newsletterId, email: 'a@example.com', name: '=HYPERLINK("bad")', fields: { count: 4, birthday: '2020-02-29' }, tags: [tag.id] })).contact
    const b = (await owner.action('contacts.create', { newsletterId, email: 'b@example.com', name: 'Beta' })).contact
    const c = (await owner.action('contacts.create', { newsletterId, email: 'c@example.com', name: 'Beta' })).contact
    let cursor: string | undefined
    const ids: string[] = []
    do { const page = await owner.action('contacts.list', { newsletterId, sort: 'name', direction: 'asc', limit: 1, cursor }); ids.push(...page.contacts.map((r) => r.id)); cursor = page.nextCursor ?? undefined } while (cursor)
    assert.equal(new Set(ids).size, 3)
    assert.equal((await owner.action('contacts.list', { newsletterId, tagId: tag.id })).contacts.length, 1)
    assert.equal((await owner.action('contacts.list', { newsletterId, search: 'beta' })).contacts.length, 2)
    await owner.action('contacts.bulk', { newsletterId, contactIds: [b.id, c.id], operation: 'tag', tagIds: [tag.id] })
    assert.equal((await owner.action('contacts.list', { newsletterId, tagId: tag.id })).contacts.length, 3)
    await owner.action('contacts.bulk', { newsletterId, contactIds: [b.id], operation: 'untag', tagIds: [tag.id] })
    assert.equal((await owner.action('contacts.get', { newsletterId, contactId: b.id })).tags.length, 0)
    const exp = await owner.action('contacts.export', { newsletterId, sort: 'email', direction: 'asc', limit: 1 })
    assert.match(exp.csv, /"'=HYPERLINK\(""bad""\)"/)
    assert.ok(exp.nextCursor)
    const response = await owner.fetch('/api/actions/contacts.export?newsletterId=' + newsletterId)
    assert.equal(response.status, 200)
    const csv = await response.text()
    assert.equal(csv.split('\r\n').filter(Boolean).length, 4)
    await owner.action('contactFields.delete', { newsletterId, fieldId: countField.id })
    assert.deepEqual((await owner.action('contacts.get', { newsletterId, contactId: a.id })).contact.fields, { birthday: '2020-02-29' })
    await owner.action('contacts.bulk', { newsletterId, contactIds: [b.id, c.id], operation: 'unsubscribe' })
    assert.equal((await owner.action('contacts.list', { newsletterId, status: 'unsubscribed' })).contacts.length, 2)
    await owner.action('tags.delete', { newsletterId, tagId: tag.id })
    assert.equal((await owner.action('contacts.get', { newsletterId, contactId: a.id })).tags.length, 0)
    await owner.action('contacts.bulk', { newsletterId, contactIds: [b.id, c.id], operation: 'delete' })
    assert.equal((await owner.action('contacts.list', { newsletterId })).contacts.length, 1)
  } finally { install.close() }
})

test('manual suppressions can only be removed manually and do not resubscribe contacts', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Suppression test' })
    const contact = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'a@example.com' })).contact
    await owner.action('suppressions.add', { accountId: owner.accountId!, email: 'a@example.com' })
    const list = await owner.action('suppressions.list', { accountId: owner.accountId! })
    const manual = list.suppressions.find((s) => s.reason === 'manual')!
    const local = list.suppressions.find((s) => s.reason === 'unsubscribed')!
    assert.equal((await expectError(() => owner.action('suppressions.remove', { accountId: owner.accountId!, suppressionId: local.id }))).status, 404)
    await owner.action('suppressions.remove', { accountId: owner.accountId!, suppressionId: manual.id })
    assert.equal((await owner.action('contacts.get', { newsletterId: nl.id, contactId: contact.id })).contact.status, 'unsubscribed')
  } finally { install.close() }
})

test('HTTP membership and other account access cannot leak contacts or streamed exports', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'member@example.com,other@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const a = await owner.action('newsletters.create', { name: 'Member list' })
    const b = await owner.action('newsletters.create', { name: 'Private list' })
    const contact = (await owner.action('contacts.create', { newsletterId: b.id, email: 'private@example.com' })).contact
    const member = await install.signUp({ email: 'member@example.com' })
    install.app.control.ctx.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, ?, ?, ?)', member.session.user.id, owner.accountId, a.id, 'member', install.clock.now())
    await member.post('/api/auth/account', { accountId: owner.accountId })
    await member.refresh()
    assert.equal((await member.actionRaw('contacts.get', { newsletterId: a.id, contactId: contact.id })).status, 404)
    assert.equal((await member.actionRaw('contacts.list', { newsletterId: b.id })).status, 403)
    assert.equal((await member.fetch('/api/actions/contacts.export?newsletterId=' + b.id)).status, 403)
    assert.equal((await install.fetch('/api/actions/contacts.export?newsletterId=' + b.id)).status, 401)
    const other = await install.signUp({ email: 'other@example.com' })
    assert.equal((await other.actionRaw('contacts.get', { newsletterId: b.id, contactId: contact.id })).status, 404)
    const response = await owner.actionRaw('contacts.update', { newsletterId: b.id, contactId: contact.id, fields: { bad: 'x' } })
    assert.equal(response.status, 400)
  } finally { install.close() }
})

test('invalid dates fail without writes and every CSV formula prefix is neutralized', async () => {
  const { csvCell } = await import('../account/contacts/index.ts')
  for (const text of ['=1+1', '+1+1', '-1+1', '@SUM(1)', '  =1+1', '\tplain', '\rplain', '\nplain', '\u0000=1+1']) assert.ok(csvCell(text).startsWith('"\''), JSON.stringify(text))
  assert.equal(csvCell('a"b'), '"a""b"')
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Date tests' })
    await owner.action('contactFields.create', { newsletterId: nl.id, key: 'birthday', label: 'Birthday', type: 'date' })
    for (const value of ['2021-02-29', '2020-13-99', 'invalid']) {
      assert.equal((await owner.actionRaw('contacts.create', { newsletterId: nl.id, email: 'invalid@example.com', fields: { birthday: value } })).status, 400)
    }
    assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts.length, 0)
  } finally { install.close() }
})
