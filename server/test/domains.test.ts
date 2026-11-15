import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { verifiedSenderFor } from '../account/domains/index.ts'

for (const cloud of [false, true]) test(`sending domains verify, fail and recover on daily recheck (${cloud ? 'cloud' : 'self-hosted'})`, async (t) => {
  const install = await createInstall({ cloud })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const newsletter = await owner.action('newsletters.create', { name: 'Weekly' })
  const domain = await owner.action('domains.add', { name: 'EXAMPLE.COM' })
  assert.equal(domain.status, 'pending')
  assert.equal(domain.name, 'example.com')
  assert.equal((await expectError(() => owner.action('newsletters.update', { newsletterId: newsletter.id, domainId: domain.id }))).code, 'domain_unverified')
  assert.equal((await expectError(() => owner.action('newsletters.update', { newsletterId: newsletter.id, domainId: 'missing' }))).code, 'domain_unverified')
  assert.equal((await owner.action('domains.add', { name: 'example.com' })).id, domain.id)
  assert.equal((await owner.action('domains.check', { domainId: domain.id })).status, 'pending')
  install.dns.set('example.com', 'TXT', ['"v=spf1 include:example.com ~all"'])
  install.dns.set('_dmarc.example.com', 'TXT', ['v=DMARC1; p=none'])
  assert.equal((await owner.action('domains.check', { domainId: domain.id })).status, 'verified')
  const ctx = install.app.account(owner.accountId!).ctx
  assert.equal((await owner.action('newsletters.update', { newsletterId: newsletter.id, fromName: 'Weekly', fromLocal: 'news', domainId: domain.id })).domainId, domain.id)
  assert.equal(verifiedSenderFor(ctx, newsletter.id)?.from, '"Weekly" <news@example.com>')
  assert.equal((await owner.action('domains.senders', { newsletterId: newsletter.id }))[0].id, domain.id)
  install.dns.set('example.com', 'TXT', [])
  install.clock.advance(86_400_000)
  await install.runJobs()
  assert.equal((await owner.action('domains.list', {}))[0].status, 'failed')
  assert.equal(verifiedSenderFor(ctx, newsletter.id), null)
  assert.deepEqual(await owner.action('domains.senders', { newsletterId: newsletter.id }), [])
  assert.equal((await expectError(() => owner.action('newsletters.update', { newsletterId: newsletter.id, domainId: domain.id }))).code, 'domain_unverified')
  install.dns.set('example.com', 'TXT', ['v=spf1 include:example.com ~all'])
  install.clock.advance(86_400_000)
  await install.runJobs()
  assert.equal((await owner.action('domains.list', {}))[0].status, 'verified')
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE type = ?', 'domain.failed')!.n, 1)
  assert.equal((await owner.action('newsletters.update', { newsletterId: newsletter.id, domainId: null })).domainId, null)
  assert.equal(verifiedSenderFor(ctx, newsletter.id), null)
  await owner.action('newsletters.update', { newsletterId: newsletter.id, domainId: domain.id })
  await owner.action('domains.delete', { domainId: domain.id })
  assert.deepEqual(await owner.action('domains.list', {}), [])
  assert.equal(verifiedSenderFor(ctx, newsletter.id), null)
  assert.equal((await expectError(() => owner.action('domains.check', { domainId: domain.id }))).status, 404)
})

test('domain actions require the owner, stay account-scoped, and prevent cross-account provider deletion', async (t) => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const other = await install.signUp({ email: 'other@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const domain = await owner.action('domains.add', { name: 'example.com' })
  assert.equal((await expectError(() => other.action('domains.check', { domainId: domain.id }))).status, 404)
  assert.equal((await expectError(() => other.action('domains.add', { name: 'example.com' }))).code, 'domain_claimed')
  const otherNl = await other.action('newsletters.create', { name: 'Other newsletter' })
  assert.equal((await expectError(() => other.action('newsletters.update', { newsletterId: otherNl.id, domainId: domain.id }))).code, 'domain_unverified')
  const member: Actor = { userId: 'usr_member', email: 'member@example.com', owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
  const ctx = install.app.account(owner.accountId!).ctx
  for (const [name, input] of [['domains.list', {}], ['domains.check', { domainId: domain.id }], ['domains.delete', { domainId: domain.id }], ['domains.add', { name: 'sub.example.com' }]] as const) await assert.rejects(runAction(ctx, name, input, member), { status: 403 })
  await owner.action('domains.delete', { domainId: domain.id })
  await install.runJobs()
  assert.equal((await other.action('domains.add', { name: 'example.com' })).status, 'pending')
})

test('SES domains need DNS records and provider verification; DMARC is suggested', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  await owner.action('install.settings.set', { values: { email_provider: 'ses', ses_region: 'us-east-1', ses_access_key_id: 'fixture-id', ses_secret_access_key: 'fixture-secret' } })
  let verified = false
  install.app.control.ctx.platform.fetch = async () => Response.json({ VerifiedForSendingStatus: verified, DkimAttributes: { Tokens: ['dkim1', 'dkim2', 'dkim3'] } })
  const domain = await owner.action('domains.add', { name: 'example.com' })
  for (const record of domain.records) if (record.required) install.dns.set(record.name, record.type, [record.value])
  assert.equal((await owner.action('domains.check', { domainId: domain.id })).status, 'pending')
  verified = true
  const checked = await owner.action('domains.check', { domainId: domain.id })
  assert.equal(checked.status, 'verified')
  assert.equal(checked.records.find((r) => r.purpose === 'DMARC')?.found, false)
  install.app.control.ctx.platform.resolveDns = async () => { throw new Error('DNS service outage') }
  assert.equal((await expectError(() => owner.action('domains.check', { domainId: domain.id }))).status, 502)
  assert.equal((await owner.action('domains.list', {}))[0].status, 'verified')
})
