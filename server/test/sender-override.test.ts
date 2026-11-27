/**
 * The optional per-campaign sender override (fromDomainId, fromLocal, fromName) on campaigns, the welcome email and sequence steps.
 * Each field falls back to the newsletter's own on its own; the effective domain must be verified at save and again at send.
 * Mail is captured at the provider seam or read from the test outbox: nothing leaves the process.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { APP_URL, expectError, type Install } from './harness.ts'
import { addContacts, createIssue, drive, issueDoc, sendableInstall } from './sending-setup.ts'
import { sendHooks } from '../account/sending/index.ts'
import { verifiedSenderFor } from '../account/domains/index.ts'
import { testProvider } from '../email/test.ts'
import { buildMime } from '../email/mime.ts'
import { postshibaProvider } from '../email/postshiba.ts'
import type { EmailMessage } from '../email/index.ts'

const NEWSLETTER_FROM = '"Weekly" <news@example.com>'
const BRAND = 'brand.example.org'
const welcomeDoc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Hello {{first_name|friend}}, welcome aboard.' }] }] }

/** A sendable install with the newsletter sender on example.com, a second verified domain and every provider message captured. */
async function setup(t: TestContext) {
  const base = await sendableInstall()
  const sent: EmailMessage[] = []
  sendHooks.provider = (ctx) => {
    const provider = testProvider(ctx)
    return { ...provider, send: async (message) => { sent.push(message); return provider.send(message) } }
  }
  t.after(() => { sendHooks.provider = null; base.install.close() })
  const brand = await addDomain(base.install, base.owner, BRAND)
  return { ...base, brand, sent, replace: async (newsletterId: string) => base.owner.action('newsletters.update', { newsletterId, replyTo: 'reply@example.com' }) }
}
async function addDomain(install: Install, owner: Awaited<ReturnType<typeof sendableInstall>>['owner'], name: string) {
  const domain = await owner.action('domains.add', { name })
  install.dns.set(name, 'TXT', ['v=spf1 include:example.com ~all'])
  install.dns.set(`_dmarc.${name}`, 'TXT', ['v=DMARC1; p=none'])
  assert.equal((await owner.action('domains.check', { domainId: domain.id })).status, 'verified')
  return domain
}
const draft = (owner: Awaited<ReturnType<typeof sendableInstall>>['owner'], newsletterId: string, extra: Record<string, unknown> = {}) => createIssue(owner, newsletterId, extra)
const code = async (fn: () => Promise<unknown>) => (await expectError(fn)).code
const none = { fromDomainId: null, fromLocal: null, fromName: null }
let ip = 1
async function signup(install: Install, key: string, email: string) {
  const config: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${key}`)).json()
  install.clock.advance(2001)
  const response = await install.app.edge.fetch(new Request(`${APP_URL}/api/public/subscribe/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Reader', formToken: config.formToken }) }), `198.51.100.${ip++}`)
  assert.equal(response.status, 200)
  await install.runJobs()
}

test('no override: the effective sender is the newsletter sender, in preview, test send and the stored fields', async (t) => {
  const { owner, nl, ctx, sent, replace } = await setup(t)
  await replace(nl.id)
  const campaign = await draft(owner, nl.id)
  assert.deepEqual({ fromDomainId: campaign.fromDomainId, fromLocal: campaign.fromLocal, fromName: campaign.fromName }, none)
  assert.deepEqual(verifiedSenderFor(ctx, nl.id), { from: NEWSLETTER_FROM, replyTo: 'reply@example.com' })
  assert.deepEqual(verifiedSenderFor(ctx, nl.id, none), verifiedSenderFor(ctx, nl.id))
  const preview = await owner.action('campaigns.preview', { campaignId: campaign.id })
  assert.deepEqual(preview.sender, { from: NEWSLETTER_FROM, replyTo: 'reply@example.com' })
  await owner.action('campaigns.sendTest', { campaignId: campaign.id, to: ['tester@example.com'] })
  assert.equal(sent.length, 1)
  assert.deepEqual([sent[0].from, sent[0].replyTo], [NEWSLETTER_FROM, 'reply@example.com'])
})

test('a full override sends, previews and test-sends from the override; Reply-To stays the newsletter value', async (t) => {
  const { install, owner, nl, brand, accountId, sent, replace } = await setup(t)
  await replace(nl.id)
  const campaign = await draft(owner, nl.id, { fromDomainId: brand.id, fromLocal: 'hello', fromName: 'Sandy "S" Wp' })
  assert.deepEqual([campaign.fromDomainId, campaign.fromLocal, campaign.fromName], [brand.id, 'hello', 'Sandy "S" Wp'])
  const FROM = `"Sandy \\"S\\" Wp" <hello@${BRAND}>`
  assert.deepEqual((await owner.action('campaigns.preview', { campaignId: campaign.id })).sender, { from: FROM, replyTo: 'reply@example.com' })
  await owner.action('campaigns.sendTest', { campaignId: campaign.id, to: ['tester@example.com'] })
  assert.deepEqual([sent[0].from, sent[0].replyTo, sent[0].subject], [FROM, 'reply@example.com', '[Test] Issue one'])
  // The real send, with its List-Unsubscribe mailbox on the effective domain.
  addContacts(install.app.account(accountId).ctx, nl.id, 2)
  await owner.action('campaigns.send', { campaignId: campaign.id })
  await drive(install, owner, campaign.id)
  const real = sent.slice(1)
  assert.equal(real.length, 2)
  for (const message of real) {
    assert.deepEqual([message.from, message.replyTo], [FROM, 'reply@example.com'])
    assert.match(message.headers['List-Unsubscribe'], new RegExp(`^<mailto:unsubscribe@${BRAND.replaceAll('.', '\\.')}\\?subject=unsubscribe>`))
  }
})

test('each field falls back to the newsletter on its own, and an empty name means no display name', async (t) => {
  const { owner, nl, brand, sent } = await setup(t)
  const send = async (extra: Record<string, unknown>) => {
    const campaign = await draft(owner, nl.id, extra)
    await owner.action('campaigns.sendTest', { campaignId: campaign.id, to: ['tester@example.com'] })
    return sent.at(-1)!.from
  }
  assert.equal(await send({ fromName: 'Sandy' }), '"Sandy" <news@example.com>')
  assert.equal(await send({ fromLocal: 'hello' }), '"Weekly" <hello@example.com>')
  assert.equal(await send({ fromDomainId: brand.id }), `"Weekly" <news@${BRAND}>`)
  assert.equal(await send({ fromDomainId: brand.id, fromName: 'Sandy' }), `"Sandy" <news@${BRAND}>`)
  assert.equal(await send({ fromLocal: 'hello', fromName: '' }), '<hello@example.com>', 'a stored empty name drops the newsletter name')
  assert.equal(await send({ fromName: null, fromLocal: null, fromDomainId: null }), NEWSLETTER_FROM)
})

test('on update null clears one field, omitting keeps it, and every campaign read shows the override', async (t) => {
  const { owner, nl, brand } = await setup(t)
  const created = await draft(owner, nl.id, { fromDomainId: brand.id, fromLocal: 'hello', fromName: 'Sandy' })
  const keep = await owner.action('campaigns.update', { campaignId: created.id, revision: created.revision, subject: 'Renamed' })
  assert.deepEqual([keep.fromDomainId, keep.fromLocal, keep.fromName], [brand.id, 'hello', 'Sandy'], 'omitted keeps the stored override')
  const noName = await owner.action('campaigns.update', { campaignId: created.id, revision: keep.revision, fromName: null })
  assert.deepEqual([noName.fromDomainId, noName.fromLocal, noName.fromName], [brand.id, 'hello', null])
  const emptyName = await owner.action('campaigns.update', { campaignId: created.id, revision: noName.revision, fromName: '' })
  assert.equal(emptyName.fromName, '', 'an empty string is a value, not a clear')
  const nameOnly = await owner.action('campaigns.update', { campaignId: created.id, revision: emptyName.revision, fromDomainId: null, fromLocal: null, fromName: 'Only' })
  assert.deepEqual([nameOnly.fromDomainId, nameOnly.fromLocal, nameOnly.fromName], [null, null, 'Only'])
  const cleared = await owner.action('campaigns.update', { campaignId: created.id, revision: nameOnly.revision, ...none })
  assert.deepEqual({ fromDomainId: cleared.fromDomainId, fromLocal: cleared.fromLocal, fromName: cleared.fromName }, none)

  const set = await owner.action('campaigns.update', { campaignId: created.id, revision: cleared.revision, fromDomainId: brand.id, fromLocal: 'hello', fromName: 'Sandy' })
  assert.deepEqual((await owner.action('campaigns.get', { campaignId: created.id })).fromLocal, 'hello')
  const listed = (await owner.action('campaigns.list', { newsletterId: nl.id })).campaigns.find((c) => c.id === created.id)!
  assert.deepEqual([listed.fromDomainId, listed.fromLocal, listed.fromName], [brand.id, 'hello', 'Sandy'])
  const copy = await owner.action('campaigns.duplicate', { campaignId: set.id })
  assert.deepEqual([copy.fromDomainId, copy.fromLocal, copy.fromName], [brand.id, 'hello', 'Sandy'], 'duplicate copies the override')
  // A new campaign, and one made without the fields, start with no override.
  const plain = await owner.action('campaigns.create', { newsletterId: nl.id })
  assert.deepEqual({ fromDomainId: plain.fromDomainId, fromLocal: plain.fromLocal, fromName: plain.fromName }, none)
  assert.deepEqual((await owner.action('campaigns.create', { newsletterId: nl.id, ...none })).fromLocal, null)
})

test('save-time validation: unknown, unverified and other-account domains, bad local parts and names, bad types', async (t) => {
  const { install, owner, nl } = await setup(t)
  const pending = await owner.action('domains.add', { name: 'pending.example.org' })
  const other = await install.signUp({ email: 'other@example.com' })
  const otherDomain = await other.action('domains.add', { name: 'theirs.example.net' })
  const campaign = await draft(owner, nl.id)
  const update = (input: Record<string, unknown>) => owner.action('campaigns.update', { campaignId: campaign.id, revision: campaign.revision, ...input } as never)
  for (const fromDomainId of ['dom_missing', pending.id, otherDomain.id]) {
    assert.equal(await code(() => update({ fromDomainId })), 'domain_unverified', String(fromDomainId))
    assert.equal(await code(() => owner.action('campaigns.create', { newsletterId: nl.id, fromDomainId } as never)), 'domain_unverified')
  }
  for (const fromLocal of ['', 'a b', 'a@b', 'a<b>', 'x'.repeat(65), 'né', 'a\nb']) assert.equal(await code(() => update({ fromLocal })), 'invalid_input', JSON.stringify(fromLocal))
  for (const fromName of ['a\nb', 'a\rb', 'x'.repeat(201), 'A <b@c.d>']) assert.equal(await code(() => update({ fromName })), 'invalid_input', JSON.stringify(fromName))
  for (const input of [{ fromDomainId: 5 }, { fromDomainId: '' }, { fromLocal: 5 }, { fromName: false }, { fromName: ['a'] }]) assert.equal(await code(() => update(input)), 'invalid_input', JSON.stringify(input))
  assert.equal((await owner.action('campaigns.get', { campaignId: campaign.id })).fromLocal, null, 'nothing was saved')
  // The effective sender must work too: a name-only override on a newsletter whose own sender is unusable fails closed.
  const bare = await owner.action('newsletters.create', { name: 'No sender' })
  assert.equal(await code(() => owner.action('campaigns.create', { newsletterId: bare.id, fromName: 'Sandy' } as never)), 'sender_unverified')
  // ...but a full override works without a newsletter sender, and unrelated saves never re-check it.
  const brand = (await owner.action('domains.list', {})).find((d) => d.name === BRAND)!
  const alone = await owner.action('campaigns.create', { newsletterId: bare.id, fromDomainId: brand.id, fromLocal: 'hello' })
  assert.deepEqual((await owner.action('campaigns.preview', { campaignId: alone.id })).sender, { from: `"No sender" <hello@${BRAND}>` })
})

test('a domain that fails, goes missing or is deleted stops the send, test send and review', async (t) => {
  const { install, owner, nl, brand, ctx, sent } = await setup(t)
  const campaign = await draft(owner, nl.id, { fromDomainId: brand.id, fromLocal: 'hello' })
  await owner.action('campaigns.sendTest', { campaignId: campaign.id, to: ['tester@example.com'] })
  assert.equal(sent.length, 1)

  // Failed: the newsletter domain is still fine, but the effective one is not.
  install.dns.set(BRAND, 'TXT', [])
  install.clock.advance(86_400_000)
  await install.runJobs()
  assert.equal((await owner.action('domains.list', {})).find((d) => d.id === brand.id)!.status, 'failed')
  assert.ok(verifiedSenderFor(ctx, nl.id), 'the newsletter sender is untouched')
  assert.equal(await code(() => owner.action('campaigns.sendTest', { campaignId: campaign.id, to: ['tester@example.com'] })), 'sender_unverified')
  assert.equal(sent.length, 1, 'nothing was handed to the provider')
  assert.equal(await code(() => owner.action('campaigns.send', { campaignId: campaign.id })), 'review_failed')
  const checks = (await owner.action('campaigns.preview', { campaignId: campaign.id })).checks
  assert.ok(checks.some((c) => c.id === 'sender_domain' && c.level === 'error'))
  assert.equal((await owner.action('campaigns.preview', { campaignId: campaign.id })).sender, null)

  // Missing: a stored id that points at no domain.
  ctx.db.run('UPDATE campaigns SET from_domain_id = ? WHERE id = ?', 'dom_gone', campaign.id)
  assert.equal(await code(() => owner.action('campaigns.sendTest', { campaignId: campaign.id, to: ['tester@example.com'] })), 'sender_unverified')
  assert.equal(await code(() => owner.action('campaigns.send', { campaignId: campaign.id })), 'review_failed')

  // Deleting a domain clears the pointer, as it does for newsletters, so nothing is left aimed at it.
  ctx.db.run('UPDATE campaigns SET from_domain_id = ? WHERE id = ?', brand.id, campaign.id)
  await owner.action('domains.delete', { domainId: brand.id })
  assert.equal((await owner.action('campaigns.get', { campaignId: campaign.id })).fromDomainId, null)
  assert.equal((await owner.action('campaigns.get', { campaignId: campaign.id })).fromLocal, 'hello')
})

test('a campaign sending when its override domain fails pauses instead of sending from it', async (t) => {
  const { install, owner, nl, brand, ctx, accountId, sent } = await setup(t)
  addContacts(install.app.account(accountId).ctx, nl.id, 3)
  const campaign = await draft(owner, nl.id, { fromDomainId: brand.id, fromLocal: 'hello' })
  await owner.action('campaigns.send', { campaignId: campaign.id })
  ctx.db.run("UPDATE domains SET status = 'failed' WHERE id = ?", brand.id)
  await drive(install, owner, campaign.id, { maxSeconds: 5 })
  const after = await owner.action('campaigns.get', { campaignId: campaign.id })
  assert.equal(after.status, 'paused')
  assert.equal(after.pauseReason, 'sender_unverified')
  assert.equal(sent.length, 0)
  assert.equal(await code(() => owner.action('campaigns.resume', { campaignId: campaign.id })), 'sender_unverified')
})

test('the welcome email: saveWelcome and signup.get carry the override, delivery uses it and re-checks the domain', async (t) => {
  const { install, owner, nl, brand, ctx } = await setup(t)
  await owner.action('signup.update', { newsletterId: nl.id, settings: (await owner.action('signup.get', { newsletterId: nl.id })).settings, doubleOptIn: false })
  const mailFrom = (email: string) => JSON.parse(ctx.db.get<{ message: string }>("SELECT m.message FROM signup_mail m JOIN contacts c ON c.id = m.contact_id WHERE c.email = ? AND m.kind = 'welcome'", email)!.message) as EmailMessage

  const first = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: null })
  assert.deepEqual({ fromDomainId: first.welcome!.fromDomainId, fromLocal: first.welcome!.fromLocal, fromName: first.welcome!.fromName }, none, 'a new welcome email has no override')
  // Without an override it still goes from the install's system address, as before.
  await signup(install, nl.key, 'a@example.com')
  assert.match(mailFrom('a@example.com').from, /^Weekly <mailcorgi@/)

  const saved = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: first.welcome!.revision, fromDomainId: brand.id, fromLocal: 'hello', fromName: 'Sandy' })
  assert.deepEqual([saved.welcome!.fromDomainId, saved.welcome!.fromLocal, saved.welcome!.fromName], [brand.id, 'hello', 'Sandy'])
  const got = (await owner.action('signup.get', { newsletterId: nl.id })).welcome!
  assert.deepEqual([got.fromDomainId, got.fromLocal, got.fromName], [brand.id, 'hello', 'Sandy'])
  await owner.action('newsletters.update', { newsletterId: nl.id, replyTo: 'reply@example.com' })
  await signup(install, nl.key, 'b@example.com')
  assert.deepEqual([mailFrom('b@example.com').from, mailFrom('b@example.com').replyTo], [`"Sandy" <hello@${BRAND}>`, 'reply@example.com'])
  // Its test send and preview use the same effective sender.
  assert.deepEqual((await owner.action('campaigns.preview', { campaignId: got.id })).sender, { from: `"Sandy" <hello@${BRAND}>`, replyTo: 'reply@example.com' })

  // Omit keeps, null clears one field, and a bad value is refused without saving.
  const kept = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome 2', doc: welcomeDoc, revision: saved.welcome!.revision })
  assert.deepEqual([kept.welcome!.fromDomainId, kept.welcome!.fromLocal, kept.welcome!.fromName], [brand.id, 'hello', 'Sandy'])
  assert.equal(await code(() => owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'x', doc: welcomeDoc, revision: kept.welcome!.revision, fromDomainId: 'dom_missing' })), 'domain_unverified')
  assert.equal(await code(() => owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'x', doc: welcomeDoc, revision: kept.welcome!.revision, fromLocal: 'a b' })), 'invalid_input')
  const noName = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome 2', doc: welcomeDoc, revision: kept.welcome!.revision, fromName: null })
  assert.deepEqual([noName.welcome!.fromDomainId, noName.welcome!.fromName], [brand.id, null])

  // A domain that is no longer verified at send time: the welcome email is refused, not sent from the newsletter sender.
  ctx.db.run("UPDATE domains SET status = 'failed' WHERE id = ?", brand.id)
  await signup(install, nl.key, 'c@example.com')
  assert.equal(install.outbox(owner.accountId!).filter((m) => m.to_email === 'c@example.com').length, 0)
  assert.equal(ctx.db.get<{ state: string }>("SELECT m.state FROM signup_mail m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'c@example.com' AND m.kind = 'welcome'")!.state, 'failed')
})

test('sequence steps: the override on create, addStep, updateStep and every step list; review and sending use it', async (t) => {
  const { install, owner, nl, brand, ctx, accountId, sent } = await setup(t)
  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'new-signup' })
  const sequence = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'tag', tagId: tag.id }, steps: [
    { delayDays: 1, subject: 'Day 1', doc: issueDoc() as never, fromDomainId: brand.id, fromLocal: 'hello', fromName: 'Sandy' },
    { delayDays: 2, subject: 'Day 2', doc: issueDoc() as never },
  ] })
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const shape = (s: { fromDomainId: string | null; fromLocal: string | null; fromName: string | null }) => [s.fromDomainId, s.fromLocal, s.fromName]
  assert.deepEqual(sequence.steps.map(shape), [[brand.id, 'hello', 'Sandy'], [null, null, null]])
  const added = await owner.action('sequences.addStep', { ...at, delayDays: 3, subject: 'Day 3', doc: issueDoc() as never, fromName: 'Third' })
  assert.deepEqual(shape(added), [null, null, 'Third'])
  const second = sequence.steps[1]
  const updated = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: second.revision, fromLocal: 'second' })
  assert.deepEqual(shape(updated), [null, 'second', null])
  const renamed = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: updated.revision, subject: 'Second day' })
  assert.deepEqual(shape(renamed), [null, 'second', null], 'omitted keeps')
  const cleared = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: renamed.revision, fromLocal: null })
  assert.deepEqual(shape(cleared), [null, null, null], 'null clears')
  await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: cleared.revision, fromLocal: 'second' })
  const expected = [[brand.id, 'hello', 'Sandy'], [null, 'second', null], [null, null, 'Third']]
  const got = await owner.action('sequences.get', at)
  assert.deepEqual(got.steps.map(shape), expected)
  assert.deepEqual((await owner.action('sequences.reorderSteps', { ...at, stepIds: got.steps.map((s) => s.id) })).steps.map(shape), expected)
  assert.deepEqual((await owner.action('sequences.deleteStep', { ...at, stepId: got.steps[2].id })).steps.map(shape), expected.slice(0, 2))
  assert.equal(await code(() => owner.action('sequences.addStep', { ...at, delayDays: 5, fromDomainId: 'dom_missing' })), 'domain_unverified')
  assert.equal(await code(() => owner.action('sequences.addStep', { ...at, delayDays: 5, fromLocal: 'a b' })), 'invalid_input')
  assert.equal(await code(() => owner.action('sequences.create', { newsletterId: nl.id, name: 'Bad', entry: { type: 'manual' }, steps: [{ delayDays: 1, fromName: 'a\nb' }] })), 'invalid_input')
  assert.equal((await owner.action('sequences.get', at)).steps.length, 2, 'refused saves added nothing')

  // Review: a step whose own domain is unverified fails activation, naming the step.
  ctx.db.run("UPDATE domains SET status = 'failed' WHERE id = ?", brand.id)
  const failed = await expectError(() => owner.action('sequences.activate', at))
  assert.deepEqual([failed.code, failed.message.startsWith('Step 1:')], ['review_failed', true])
  ctx.db.run("UPDATE domains SET status = 'verified' WHERE id = ?", brand.id)
  await owner.action('sequences.activate', at)
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', name: 'Ada', tags: [tag.id] })
  install.clock.advance(86_400_000)
  await install.runJobs()
  assert.equal(sent.at(-1)!.from, `"Sandy" <hello@${BRAND}>`)

  // Day 2 is due while step 2's effective sender (its own local on the newsletter domain) works: it uses it.
  install.clock.advance(86_400_000)
  await install.runJobs()
  assert.equal(sent.at(-1)!.from, '"Weekly" <second@example.com>')
  assert.equal(install.outbox(accountId).filter((m) => m.kind === 'campaign').length, 2)

  // A second contact whose first step's domain fails by then waits instead of being sent from elsewhere.
  // The daily recheck runs in the same jobs pass, so its DNS answer fails too.
  install.dns.set(BRAND, 'TXT', [])
  ctx.db.run("UPDATE domains SET status = 'failed' WHERE id = ?", brand.id)
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'bob@example.com', name: 'Bob', tags: [tag.id] })
  install.clock.advance(86_400_000)
  await install.runJobs()
  assert.deepEqual(sent.filter((m) => m.to === 'bob@example.com').map((m) => [m.from, m.subject]), [])
})

test('REST and MCP take, clear and return the override fields', async (t) => {
  const { install, owner, nl, brand } = await setup(t)
  const key = await owner.action('apikeys.create', { name: 'Automation', access: 'full' })
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const rest = async (method: string, path: string, body?: unknown) => { const r = await install.fetch(`/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() } }
  const mcp = async (name: string, args: unknown) => (await (await install.fetch('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result
  const created = await rest('POST', `/newsletters/${nl.id}/campaigns`, { subject: 'Hi', fromDomainId: brand.id, fromLocal: 'hello', fromName: 'Sandy' })
  assert.equal(created.status, 200)
  assert.deepEqual([created.body.fromDomainId, created.body.fromLocal, created.body.fromName], [brand.id, 'hello', 'Sandy'])
  const patched = await rest('PATCH', `/campaigns/${created.body.id}`, { revision: created.body.revision, fromName: null })
  assert.deepEqual([patched.body.fromLocal, patched.body.fromName], ['hello', null])
  const bad = await rest('PATCH', `/campaigns/${created.body.id}`, { revision: patched.body.revision, fromLocal: 'a b' })
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_input'])
  const unknown = await rest('PATCH', `/campaigns/${created.body.id}`, { revision: patched.body.revision, fromDomainId: 'dom_missing' })
  assert.deepEqual([unknown.status, unknown.body.error.code], [400, 'domain_unverified'])
  assert.deepEqual((await rest('GET', `/campaigns/${created.body.id}/preview`)).body.sender, { from: `"Weekly" <hello@${BRAND}>` })

  const viaMcp = await mcp('campaigns_update', { campaignId: created.body.id, revision: patched.body.revision, fromDomainId: null, fromLocal: null, fromName: 'Via MCP' })
  assert.equal(viaMcp.isError, false)
  assert.deepEqual([viaMcp.structuredContent.fromDomainId, viaMcp.structuredContent.fromLocal, viaMcp.structuredContent.fromName], [null, null, 'Via MCP'])
  assert.equal((await mcp('campaigns_get', { campaignId: created.body.id })).structuredContent.fromName, 'Via MCP')
  assert.equal((await mcp('campaigns_list', { newsletterId: nl.id })).structuredContent.campaigns[0].fromName, 'Via MCP')
  assert.equal((await mcp('campaigns_duplicate', { campaignId: created.body.id })).structuredContent.fromName, 'Via MCP')
  assert.equal((await mcp('campaigns_update', { campaignId: created.body.id, revision: 99, fromLocal: 5 })).isError, true)

  const welcome = await mcp('signup_saveWelcome', { newsletterId: nl.id, enabled: false, subject: 'Welcome', revision: null, fromDomainId: brand.id, fromLocal: 'hello' })
  assert.deepEqual([welcome.structuredContent.welcome.fromDomainId, welcome.structuredContent.welcome.fromLocal], [brand.id, 'hello'])
  assert.equal((await mcp('signup_get', { newsletterId: nl.id })).structuredContent.welcome.fromLocal, 'hello')
  const step = await mcp('sequences_create', { newsletterId: nl.id, name: 'Seq', entry: { type: 'manual' }, steps: [{ delayDays: 1, fromName: 'Step' }] })
  assert.equal(step.structuredContent.steps[0].fromName, 'Step')
  const stepRest = await rest('POST', `/newsletters/${nl.id}/sequences/${step.structuredContent.id}/steps`, { delayDays: 2, fromLocal: 'step' })
  assert.deepEqual([stepRest.body.fromLocal, stepRest.body.fromName, stepRest.body.fromDomainId], ['step', null, null])
})

test('provider payloads carry the effective From: MIME header and the PostShiba envelope sender', async (t) => {
  const { owner, nl, brand, sent } = await setup(t)
  const campaign = await draft(owner, nl.id, { fromDomainId: brand.id, fromLocal: 'hello', fromName: 'Sandy' })
  await owner.action('campaigns.sendTest', { campaignId: campaign.id, to: ['tester@example.com'] })
  const message = sent[0]
  assert.equal(message.from, `"Sandy" <hello@${BRAND}>`)
  assert.match(buildMime(message), new RegExp(`From: "Sandy" <hello@${BRAND.replaceAll('.', '\\.')}>`))
  const calls: Request[] = []
  const fakeCtx = { platform: { fetch: async (input: string | URL | Request, init?: RequestInit) => { calls.push(new Request(input, init)); return Response.json({ success_count: 1, fail_count: 0, failed_recipients: [], errors: [] }) } }, now: () => Date.now() } as never
  await postshibaProvider(fakeCtx, { postshiba_user: 'smtp_fixture', postshiba_password: 'placeholder-password' }).send(message)
  const body = await calls[0].json()
  assert.equal(body.envelope_sender, `hello@${BRAND}`, 'MAIL FROM follows the effective From')
  assert.equal(body.content.headers.From, `"Sandy" <hello@${BRAND}>`)
})
