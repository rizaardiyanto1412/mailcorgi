import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Papa from 'papaparse'
import { createInstall, expectError } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import { Budget, runDueJobs } from '../core/jobs.ts'
import { hmac, toHex } from '../core/crypto.ts'
import { classifyDomain } from '../account/imports/cleaning.ts'
import { detectPreset, suggestMapping } from '../account/imports/presets.ts'
import type { CsvRow } from '../account/imports/model.ts'
import { finish, upload } from './imports-setup.ts'
import { setContactStatus } from '../account/contacts/index.ts'

for (const fixture of fs.readdirSync(new URL('./fixtures/imports/', import.meta.url)).filter((f) => f.endsWith('.csv'))) {
  test(`preset fixture ${fixture} preserves consent, opt-outs and signup dates`, async () => {
    const install = await createInstall()
    try {
      install.dns.set('example.com', 'MX', ['10 mx.example.com'])
      const owner = await install.signUp({ email: 'owner@example.com' })
      const nl = await owner.action('newsletters.create', { name: 'Import fixture' })
      const csv = Papa.parse<CsvRow>(fs.readFileSync(new URL('./fixtures/imports/' + fixture, import.meta.url), 'utf8'), { header: true, skipEmptyLines: true })
      assert.equal(csv.errors.length, 0)
      const headers = csv.meta.fields ?? []
      const mapping = suggestMapping(headers)
      const preset = detectPreset(headers)
      const expected = fixture.replace('.csv', '').split('-')[0]
      assert.equal(preset.toLowerCase(), expected)
      const defaultStatus = fixture.includes('unsubscribed') ? 'unsubscribed' : fixture.includes('cleaned') ? 'cleaned' : 'subscribed'
      const id = await upload(owner, nl.id, csv.data, { preset, mapping, options: { consent: true, defaultStatus } })
      const report = await finish(install, owner, nl.id, id)
      assert.equal(report.processedRows, csv.data.length)
      const contacts = (await owner.action('contacts.list', { newsletterId: nl.id })).contacts
      for (const contact of contacts) {
        if (contact.email.startsWith('active')) { assert.equal(contact.status, 'subscribed'); assert.equal(contact.subscribedAt, Date.UTC(2024, 0, 2, 3, 4, 5)) }
        else { assert.notEqual(contact.status, 'subscribed'); assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: contact.email })).outcome, 'suppressed') }
      }
      assert.equal(contacts.length, csv.data.length)
    } finally { install.close() }
  })
}

test('upload sequences are idempotent, conflicts and gaps fail, and stalled uploads end', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Upload test' })
    const imp = await owner.action('imports.create', { newsletterId: nl.id, mapping: { email: 'email' } })
    const input = { newsletterId: nl.id, importId: imp.id, seq: 1, rows: [{ email: 'reader@example.com' }] }
    assert.equal((await owner.action('imports.addChunk', input)).accepted, true)
    assert.equal((await owner.action('imports.addChunk', input)).accepted, false)
    assert.equal((await expectError(() => owner.action('imports.addChunk', { ...input, rows: [{ email: 'different@example.com' }] }))).code, 'chunk_conflict')
    assert.equal((await expectError(() => owner.action('imports.start', { newsletterId: nl.id, importId: imp.id, totalRows: 1 }))).code, 'incomplete_upload')
    install.clock.advance(3_600_001)
    await install.runJobs()
    assert.equal((await owner.action('imports.get', input)).status, 'stalled')
    assert.equal((await expectError(() => owner.action('imports.addChunk', { ...input, seq: 2 }))).status, 409)
    assert.equal((await owner.action('imports.get', input)).totalRows, 1)
  } finally { install.close() }
})

test('cleaning covers duplicates, suppression, tombstones, typo suggestions, bad fields and formula-safe CSV', async () => {
  const install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Cleaning test' })
    const existing = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'deleted@example.com' })).contact
    await owner.action('contacts.delete', { newsletterId: nl.id, contactId: existing.id })
    await owner.action('contacts.create', { newsletterId: nl.id, email: 'existing@example.com' })
    const hash = toHex(await hmac(install.app.control.ctx.keys.suppression, 'global@example.com'))
    await install.app.stores.control.reportSuppression({ emailHash: hash, reason: 'spam_trap' })
    const rows = ['reader@example.com', 'reader@example.com', 'existing@example.com', 'deleted@example.com', 'global@example.com', '=FORMULA()', 'info@example.com', 'nomx@missing.example.com'].map((email) => ({ email, status: 'subscribed', created_at: '2024-01-02T03:04:05Z' }))
    const id = await upload(owner, nl.id, rows)
    const report = await finish(install, owner, nl.id, id)
    assert.equal(report.added, 1)
    assert.deepEqual(report.skipped, { duplicate_file: 1, duplicate_existing: 1, deleted: 1, global_suppression: 1, invalid_syntax: 1, role_address: 1, no_mx: 1 })
    const response = await owner.fetch(`/api/actions/imports.skipped?newsletterId=${nl.id}&importId=${id}`)
    assert.equal(response.status, 200)
    const csv = await response.text()
    assert.match(csv, /"'=FORMULA\(\)"/)
    assert.equal(csv.split('\r\n').filter(Boolean).length, 8)
    const ctx = install.app.account(owner.accountId!).ctx
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'import_finished'")!.n, 1)
  } finally { install.close() }
})

test('opt-outs override earlier duplicate rows and unknown statuses never subscribe', async () => {
  const install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Consent test' })
    const rows = [{ email: 'reader@example.com', status: 'subscribed' }, { email: 'reader@example.com', status: 'unsubscribed' }, { email: 'unknown@example.com', status: 'surprise' }]
    const id = await upload(owner, nl.id, rows)
    const report = await finish(install, owner, nl.id, id)
    assert.equal(report.added, 1)
    assert.equal(report.skipped.unknown_status, 1)
    const contacts = (await owner.action('contacts.list', { newsletterId: nl.id })).contacts
    assert.equal(contacts.length, 1)
    assert.equal(contacts[0].status, 'unsubscribed')
    assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com' })).outcome, 'suppressed')
  } finally { install.close() }
})

test('members, mismatched newsletters, other accounts and read keys cannot mutate imports', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Private' })
    const otherNl = await owner.action('newsletters.create', { name: 'Other' })
    const imp = await owner.action('imports.create', { newsletterId: nl.id, mapping: { email: 'email' } })
    const ctx = install.app.account(owner.accountId!).ctx
    const member: Actor = { userId: 'member', email: 'member@example.com', owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
    await assert.doesNotReject(() => runAction(ctx, 'imports.get', { newsletterId: nl.id, importId: imp.id }, member))
    await assert.doesNotReject(() => runAction(ctx, 'imports.list', { newsletterId: nl.id }, member))
    for (const action of ['imports.create', 'imports.addChunk', 'imports.start', 'imports.cancel', 'imports.skipped']) {
      await assert.rejects(runAction(ctx, action, { newsletterId: nl.id, importId: imp.id, mapping: { email: 'email' }, seq: 0, rows: [{ email: 'reader@example.com' }], totalRows: 0 }, member), (e: unknown) => e instanceof AppError && e.status === 403)
    }
    assert.equal((await expectError(() => owner.action('imports.get', { newsletterId: otherNl.id, importId: imp.id }))).status, 404)
    const other = await install.signUp({ email: 'other@example.com' })
    assert.equal((await other.actionRaw('imports.get', { newsletterId: nl.id, importId: imp.id })).status, 404)
    assert.equal((await install.fetch(`/api/actions/imports.skipped?newsletterId=${nl.id}&importId=${imp.id}`)).status, 401)
    member.owner = true; member.access = 'read'
    await assert.doesNotReject(() => runAction(ctx, 'imports.list', { newsletterId: nl.id }, member))
    await assert.doesNotReject(() => runAction(ctx, 'imports.skipped', { newsletterId: nl.id, importId: imp.id }, member))
    for (const action of ['imports.create', 'imports.addChunk', 'imports.start', 'imports.cancel']) {
      await assert.rejects(runAction(ctx, action, { newsletterId: nl.id, importId: imp.id, mapping: { email: 'email' }, seq: 0, rows: [{ email: 'reader@example.com' }], totalRows: 0 }, member), (e: unknown) => e instanceof AppError && e.status === 403)
    }
  } finally { install.close() }
})

test('cloud contact limit reports every overflow and still preserves opt-outs', async () => {
  const install = await createInstall({ cloud: true })
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Limited' })
    await install.app.stores.account(owner.accountId!).applyPolicy({ version: 2, status: 'active', plan: 'test', limits: { maxContacts: 2, maxEmailsPerMonth: 5, maxNewsletters: 3, maxTeamPerNewsletter: 2 } })
    const rows = Array.from({ length: 6 }, (_, i) => ({ email: `reader${i}@example.com`, status: 'subscribed' }))
    rows.push({ email: 'optout@example.com', status: 'unsubscribed' })
    const id = await upload(owner, nl.id, rows)
    const report = await finish(install, owner, nl.id, id)
    assert.equal(report.added, 2)
    assert.equal(report.skipped.contact_limit, 4)
    assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: 'optout@example.com' })).outcome, 'suppressed')
  } finally { install.close() }
})

test('restart between chunks resumes without duplicates or inflated counters', async () => {
  let install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    let owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Restart' })
    const id = await upload(owner, nl.id, Array.from({ length: 501 }, (_, i) => ({ email: `restart${i}@example.com`, status: 'subscribed' })))
    await install.runJobs()
    assert.equal((await owner.action('imports.get', { newsletterId: nl.id, importId: id })).processedRows, 500)
    const cookie = owner.cookie
    install = await install.restart()
    owner = await install.clientFromCookie(cookie)
    install.clock.advance(1000)
    const report = await finish(install, owner, nl.id, id)
    assert.equal(report.added, 501)
    assert.equal(report.processedRows, 501)
    assert.deepEqual(report.skipped, {})
  } finally { install.close() }
})

test('shared outbound budget yields and cancellation during DNS prevents writes', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Budget' })
    const id = await upload(owner, nl.id, [{ email: 'reader@example.com', status: 'subscribed' }])
    const ctx = install.app.account(owner.accountId!).ctx
    await runDueJobs(ctx, new Budget(install.clock.now() + 1000, 0, install.clock.now))
    assert.equal((await owner.action('imports.get', { newsletterId: nl.id, importId: id })).processedRows, 0)
    ctx.platform.resolveDns = async () => { await owner.action('imports.cancel', { newsletterId: nl.id, importId: id }); return ['mx.example.com'] }
    install.clock.advance(1000)
    await install.runJobs()
    assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts.length, 0)
    assert.equal((await owner.action('imports.get', { newsletterId: nl.id, importId: id })).status, 'canceled')
  } finally { install.close() }
})

test('domain cleaning suggests typos and recognizes disposable subdomains', () => {
  assert.deepEqual(classifyDomain('gmial.com'), { reason: 'domain_typo', suggestion: 'gmail.com' })
  assert.equal(classifyDomain('mailinator.com').reason, 'disposable_domain')
  assert.equal(classifyDomain('sub.mailinator.com').reason, 'disposable_domain')
  assert.equal(classifyDomain('example.com').reason, null)
})

test('mapped typed fields, joined names and tags import atomically; invalid rows do not leave tags', async () => {
  const install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const newsletterId = (await owner.action('newsletters.create', { name: 'Fields' })).id
    await owner.action('contactFields.create', { newsletterId, key: 'count', label: 'Count', type: 'number' })
    await owner.action('contactFields.create', { newsletterId, key: 'birthday', label: 'Birthday', type: 'date' })
    const rows = [
      { email: 'reader@example.com', status: 'subscribed', first: 'A', last: 'Reader', count: '42', birthday: '', tags: 'Readers;Imported' },
      { email: 'bad@example.com', status: 'subscribed', first: 'B', last: 'Reader', count: 'invalid', birthday: '', tags: 'Should not exist' },
      { email: 'date@example.com', status: 'subscribed', first: 'C', last: 'Reader', count: '4', birthday: '2023-02-29', tags: 'Rollback this tag' },
    ]
    const id = await upload(owner, newsletterId, rows, { mapping: { email: 'email', status: 'status', firstName: 'first', lastName: 'last', tags: 'tags', fields: { count: 'count', birthday: 'birthday' } } })
    const report = await finish(install, owner, newsletterId, id)
    assert.equal(report.added, 1)
    assert.equal(report.skipped.invalid_field, 2)
    const contact = (await owner.action('contacts.list', { newsletterId })).contacts[0]
    assert.equal(contact.name, 'A Reader')
    assert.deepEqual(contact.fields, { count: 42 })
    assert.deepEqual((await owner.action('tags.list', { newsletterId })).tags.map((t) => t.name), ['Imported', 'Readers'])
  } finally { install.close() }
})

test('consent is required for active imports and skipping inactive rows still honors an existing opt-out', async () => {
  const install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const newsletterId = (await owner.action('newsletters.create', { name: 'Consent' })).id
    const id = await upload(owner, newsletterId, [{ email: 'reader@example.com', status: 'subscribed' }], { options: { consent: false } })
    await finish(install, owner, newsletterId, id)
    assert.equal((await owner.action('contacts.list', { newsletterId })).contacts[0].status, 'unconfirmed')
    const second = await upload(owner, newsletterId, [{ email: 'reader@example.com', status: 'unsubscribed' }], { options: { consent: true, statuses: 'activeOnly' } })
    await finish(install, owner, newsletterId, second)
    assert.equal((await owner.action('contacts.list', { newsletterId })).contacts[0].status, 'unsubscribed')
  } finally { install.close() }
})

test('repeated DNS failures end the import with a report and a notification', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const newsletterId = (await owner.action('newsletters.create', { name: 'DNS failure' })).id
    const id = await upload(owner, newsletterId, [{ email: 'reader@example.com', status: 'subscribed' }])
    const ctx = install.app.account(owner.accountId!).ctx
    ctx.platform.resolveDns = async () => { throw new Error('Resolver unavailable') }
    for (let attempt = 0; attempt < 8; attempt++) { await install.runJobs(); install.clock.advance(4_000_000) }
    const report = await owner.action('imports.get', { newsletterId, importId: id })
    assert.equal(report.status, 'failed')
    assert.equal(report.processedRows, 0)
    assert.match(report.error ?? '', /repeated processing failures/)
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'import_failed'")!.n, 1)
  } finally { install.close() }
})

test('a source unsubscribe date overrides an active type and invalid signup dates are reported', async () => {
  const install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const newsletterId = (await owner.action('newsletters.create', { name: 'Dates' })).id
    const rows = [
      { email: 'optout@example.com', status: 'regular', created_at: '2024-01-02T03:04:05Z', unsubscription_date: '2025-01-01T00:00:00Z' },
      { email: 'bad@example.com', status: 'subscribed', created_at: '2023-02-29', unsubscription_date: '' },
      { email: 'future@example.com', status: 'subscribed', created_at: '2099-01-01', unsubscription_date: '' },
    ]
    const id = await upload(owner, newsletterId, rows, { mapping: { email: 'email', status: 'status', signupDate: 'created_at', unsubscribeDate: 'unsubscription_date' } })
    const report = await finish(install, owner, newsletterId, id)
    assert.equal(report.skipped.imported_unsubscribed, 1)
    assert.equal(report.skipped.invalid_date, 2)
    assert.equal((await owner.action('contacts.list', { newsletterId })).contacts[0].status, 'unsubscribed')
  } finally { install.close() }
})

test('beehiiv detection tolerates partial, reordered and case-varied headers; unknown layouts keep editable mapping', () => {
  for (const signal of ['Subscription Tier', 'UTM_CHANNEL', 'Referral Count', 'referral_code', 'Referring Site']) {
    const headers = ['EXTRA COLUMN', signal, 'STATUS', 'Email', 'Created At']
    assert.equal(detectPreset(headers), 'beehiiv')
    assert.deepEqual(suggestMapping(headers), { email: 'Email', name: undefined, firstName: undefined, lastName: undefined, status: 'STATUS', signupDate: 'Created At', unsubscribeDate: undefined, tags: undefined, fields: {} })
  }
  assert.equal(detectPreset(['email', 'status', 'created_at']), 'generic')
  assert.equal(detectPreset(['subscription_tier']), 'generic')
  assert.equal(suggestMapping(['Unfamiliar address column']).email, '')
})

test('a consented re-import subscribes unconfirmed contacts and never revives opt-outs', async () => {
  const install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const newsletterId = (await owner.action('newsletters.create', { name: 'Reimport' })).id
    const emails = ['pending@example.com', 'left@example.com', 'bounced@example.com', 'gone@example.com']
    const first = await upload(owner, newsletterId, emails.map((email) => ({ email, status: 'subscribed' })), { options: { consent: false } })
    await finish(install, owner, newsletterId, first)
    const byEmail = async () => new Map((await owner.action('contacts.list', { newsletterId })).contacts.map((c) => [c.email, c]))
    let contacts = await byEmail()
    await owner.action('contacts.unsubscribe', { newsletterId, contactId: contacts.get('left@example.com')!.id })
    setContactStatus(install.app.account(owner.accountId!).ctx, contacts.get('bounced@example.com')!.id, 'bounced')
    await owner.action('contacts.delete', { newsletterId, contactId: contacts.get('gone@example.com')!.id })
    const second = await upload(owner, newsletterId, emails.map((email) => ({ email, status: 'subscribed' })), { options: { consent: true } })
    const report = await finish(install, owner, newsletterId, second)
    assert.equal(report.added, 0)
    assert.equal(report.updated, 1)
    assert.equal(report.skipped.duplicate_existing, undefined)
    contacts = await byEmail()
    assert.equal(contacts.get('pending@example.com')!.status, 'subscribed')
    assert.equal(contacts.get('left@example.com')!.status, 'unsubscribed')
    assert.equal(contacts.get('bounced@example.com')!.status, 'bounced')
    assert.equal(contacts.has('gone@example.com'), false)
    const notice = (await owner.action('notifications.list', {})).items.find((n) => n.title === 'Import finished' && /updated to subscribed/.test(n.body))
    assert.ok(notice)
  } finally { install.close() }
})
