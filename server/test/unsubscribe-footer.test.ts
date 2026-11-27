/**
 * Unsubscribe-footer controls: `hideUnsubscribeFooter` on campaigns and sequence steps (the visible line
 * of a plain send only), and the welcome email's `transactional` / `includeListUnsubscribeHeaders`.
 * The List-Unsubscribe headers can be dropped by a transactional welcome email and by nothing else.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP_URL, createInstall, expectError, type Install } from './harness.ts'
import { addContacts, createIssue, drive, issueDoc, parseHeaders, sendableInstall } from './sending-setup.ts'
import { renderEmail, type RenderCampaign } from '../account/render/index.ts'
import { reviewChecks } from '../account/campaigns/index.ts'
import { transactionalWelcome } from '../account/newsletters/index.ts'

const UNSUBSCRIBE = 'https://app.example.com/u/token'
const PREFERENCES = 'https://app.example.com/u/prefs'
const WEB = 'https://app.example.com/n/weekly/issue'
const HEADERS = { 'List-Unsubscribe': `<${UNSUBSCRIBE}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
const newsletter = { name: 'Weekly', postalAddress: '1 Example Street' }
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi {{first_name|there}},' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Thanks for joining.' }] }] }
const render = (campaign: RenderCampaign, transactional?: { headers: boolean }) =>
  renderEmail({ campaign: { subject: 'Welcome', format: 'doc', doc, ...campaign }, newsletter, theme: {}, transactional, recipient: { contact: { name: 'Ada Lovelace' }, links: { unsubscribe: UNSUBSCRIBE, preferences: PREFERENCES, web: WEB } } })
const BODY = 'Hi Ada,\n\nThanks for joining.'
const FOOTER = `\n\n--\nUnsubscribe: ${UNSUBSCRIBE}`
const welcomeDoc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Hello {{first_name|friend}}, welcome aboard.' }] }] }
const unsubscribeHeaders = (raw: string) => { const h = parseHeaders(raw); return [h['List-Unsubscribe'], h['List-Unsubscribe-Post']] }
const assertBothHeaders = (raw: string, shape: RegExp) => {
  const [list, post] = unsubscribeHeaders(raw)
  assert.match(list, shape)
  assert.equal(post, 'List-Unsubscribe=One-Click')
}
const CAMPAIGN_LIST = /^<mailto:unsubscribe@example\.com\?subject=unsubscribe>, <http:\/\/app\.example\.com\/u\/[\w.-]+>$/
const SIGNUP_LIST = /^<http:\/\/app\.example\.com\/u\/[\w.-]+>$/

let ip = 1
async function signup(install: Install, key: string, email: string) {
  const config: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${key}`)).json()
  install.clock.advance(2001)
  const response = await install.app.edge.fetch(new Request(`${APP_URL}/api/public/subscribe/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Reader', formToken: config.formToken }) }), `192.0.2.${ip++}`)
  assert.equal(response.status, 200)
  await install.runJobs()
}

test('hideUnsubscribeFooter drops the closing lines of a plain email and nothing else', () => {
  const shown = render({ sendFormat: 'plain' })
  assert.equal(shown.text, BODY + FOOTER)
  for (const off of [{ hideUnsubscribeFooter: false }, { hide_unsubscribe_footer: 0 }]) assert.deepEqual(render({ sendFormat: 'plain', ...off }), shown, 'false is the default')
  // Both the action's camelCase field and a stored row's 0/1 column are read.
  for (const on of [{ hideUnsubscribeFooter: true }, { hide_unsubscribe_footer: 1 }]) {
    const hidden = render({ sendFormat: 'plain', ...on })
    assert.equal(hidden.text, BODY)
    assert.equal(hidden.textOnly, true)
    // The bare HTML copy is built from the text, so it loses the line too.
    assert.equal(hidden.html, '<!doctype html><html><body><p>Hi Ada,</p><p>Thanks for joining.</p></body></html>')
    assert.doesNotMatch(hidden.text + hidden.html, /Unsubscribe|--|\/u\/token/)
    assert.deepEqual(hidden.headers, HEADERS, 'the headers stay')
  }
  assert.deepEqual(shown.headers, HEADERS)
})

test('hideUnsubscribeFooter is a no-op for an html email: the theme footer and headers stay', () => {
  const themed = render({})
  const flagged = render({ sendFormat: 'html', hideUnsubscribeFooter: true })
  assert.deepEqual(flagged, themed)
  assert.ok(flagged.html.includes(`<a href="${UNSUBSCRIBE}"`) && flagged.html.includes('>Unsubscribe</a>') && flagged.html.includes('>Preferences</a>') && flagged.html.includes('>View on the web</a>'))
  assert.match(flagged.text, new RegExp(`\nUnsubscribe: ${UNSUBSCRIBE}\nPreferences: ${PREFERENCES}\nView on the web: ${WEB}$`))
  assert.deepEqual(flagged.headers, HEADERS)
})

test('review checks pass a plain campaign that hides its unsubscribe line, and html review is unchanged', () => {
  const ids = (campaign: Record<string, unknown>) => reviewChecks({ campaign: { subject: 'Hello', format: 'html', html: '<p>Hello</p>', ...campaign }, newsletter, theme: {}, domainVerified: true }).map((check) => check.id)
  assert.deepEqual(ids({ sendFormat: 'plain', hideUnsubscribeFooter: true }), [])
  assert.deepEqual(ids({ sendFormat: 'plain', format: 'doc', doc, hideUnsubscribeFooter: true }), [])
  // Html mode still asks raw HTML for its own unsubscribe link, with or without the flag.
  assert.deepEqual(ids({ hideUnsubscribeFooter: true }), ['preview_text', 'unsubscribe'])
  assert.deepEqual(ids({}), ['preview_text', 'unsubscribe'])
  // The welcome switches mean nothing to a campaign under review: they change neither the checks nor what is rendered.
  assert.deepEqual(ids({ transactional: true, includeListUnsubscribeHeaders: false }), ['preview_text', 'unsubscribe'])
})

test('review does not ask a transactional welcome for a visible unsubscribe link, headers on or off', () => {
  const ids = (transactional?: { headers: boolean }) => reviewChecks({ campaign: { subject: 'Hello', format: 'html', html: '<p>Hello</p>', previewText: 'Hi' }, newsletter, theme: {}, domainVerified: true, transactional }).map((check) => check.id)
  assert.deepEqual(ids({ headers: false }), [])
  assert.deepEqual(ids({ headers: true }), [])
  assert.deepEqual(ids(undefined), ['unsubscribe'])
})

test('a transactional email shows no unsubscribe or preferences link, and loses its headers only when told to', () => {
  const plain = render({ sendFormat: 'plain' }, { headers: true })
  assert.equal(plain.text, BODY)
  assert.doesNotMatch(plain.html, /Unsubscribe|\/u\/token/)
  assert.deepEqual(plain.headers, HEADERS, 'headers are kept by default')
  assert.deepEqual(render({ sendFormat: 'plain' }, { headers: false }).headers, {})
  assert.equal(render({ sendFormat: 'plain' }, { headers: false }).text, BODY)

  // Html: the themed footer keeps its text, the postal address and the web link, and drops the two links.
  const themed = render({})
  const html = render({}, { headers: true })
  assert.match(themed.html, />Unsubscribe<\/a> · <a [^>]+>Preferences<\/a> · <a [^>]+>View on the web<\/a>/)
  assert.doesNotMatch(html.html, /Unsubscribe|Preferences|\/u\/token|\/u\/prefs/)
  assert.match(html.html, /<p>Thanks for reading\.<\/p><p>1 Example Street<\/p><p><a href="https:\/\/app\.example\.com\/n\/weekly\/issue"[^>]*>View on the web<\/a><\/p><\/div>/)
  assert.match(html.html, /max-width:600px/)
  assert.doesNotMatch(html.text, /Unsubscribe|Preferences|\/u\//)
  assert.ok(html.text.endsWith(`\n\nThanks for reading.\n1 Example Street\nView on the web: ${WEB}`))
  assert.deepEqual(html.headers, HEADERS)
  assert.deepEqual(render({}, { headers: false }).headers, {})
  assert.equal(render({}, { headers: false }).html, html.html)
})

test('only a welcome email can be transactional: every other kind of email gets no option', () => {
  const saved = (value: Record<string, unknown>) => ({ welcome: JSON.stringify(value) })
  const off = saved({ enabled: true, transactional: true, includeListUnsubscribeHeaders: false })
  for (const kind of ['issue', 'sequence', 'keep', 'confirm']) assert.equal(transactionalWelcome(kind, off), undefined, kind)
  assert.deepEqual(transactionalWelcome('welcome', off), { headers: false })
  assert.deepEqual(transactionalWelcome('welcome', saved({ enabled: true, transactional: true })), { headers: true }, 'headers default to kept')
  // Not transactional: includeListUnsubscribeHeaders is not read at all.
  assert.equal(transactionalWelcome('welcome', saved({ enabled: true, transactional: false, includeListUnsubscribeHeaders: false })), undefined)
  for (const legacy of [{}, { enabled: true }]) assert.equal(transactionalWelcome('welcome', saved(legacy)), undefined, 'a value saved before the switches existed')
})

test('campaigns: hideUnsubscribeFooter defaults to false, round-trips through create, update, get, list and duplicate, and rejects other types', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'One' })
  assert.equal(draft.hideUnsubscribeFooter, false)
  const hidden = await owner.action('campaigns.update', { campaignId: draft.id, revision: draft.revision, sendFormat: 'plain', hideUnsubscribeFooter: true })
  assert.deepEqual([hidden.sendFormat, hidden.hideUnsubscribeFooter], ['plain', true])
  assert.equal((await owner.action('campaigns.get', { campaignId: draft.id })).hideUnsubscribeFooter, true)
  const kept = await owner.action('campaigns.update', { campaignId: draft.id, revision: hidden.revision, subject: 'Renamed' })
  assert.equal(kept.hideUnsubscribeFooter, true, 'omitted on update keeps the value')
  // The flag is stored as given whatever the send format, and simply does nothing while the email is html.
  const html = await owner.action('campaigns.update', { campaignId: draft.id, revision: kept.revision, sendFormat: 'html' })
  assert.deepEqual([html.sendFormat, html.hideUnsubscribeFooter], ['html', true])
  assert.equal((await owner.action('campaigns.duplicate', { campaignId: draft.id })).hideUnsubscribeFooter, true)
  const created = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Two', sendFormat: 'plain', hideUnsubscribeFooter: true })
  assert.equal(created.hideUnsubscribeFooter, true)
  const back = await owner.action('campaigns.update', { campaignId: created.id, revision: created.revision, hideUnsubscribeFooter: false })
  assert.equal(back.hideUnsubscribeFooter, false)
  const list = await owner.action('campaigns.list', { newsletterId: nl.id })
  assert.deepEqual(Object.fromEntries(list.campaigns.map((c) => [c.subject, c.hideUnsubscribeFooter])), { Renamed: true, 'Renamed (copy)': true, Two: false })
  for (const hideUnsubscribeFooter of ['true', 1, 0, null, 'yes', {}]) {
    assert.equal((await expectError(() => owner.action('campaigns.create', { newsletterId: nl.id, hideUnsubscribeFooter } as never))).code, 'invalid_input')
    const refused = await expectError(() => owner.action('campaigns.update', { campaignId: draft.id, revision: html.revision, hideUnsubscribeFooter } as never))
    assert.deepEqual([refused.code, refused.status], ['invalid_input', 400])
  }
  assert.equal((await owner.action('campaigns.get', { campaignId: draft.id })).revision, html.revision, 'a rejected value saves nothing')
})

test('a campaign row written before the column existed reads as hideUnsubscribeFooter false', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const ctx = install.app.account(owner.accountId!).ctx
  ctx.db.run("INSERT INTO campaigns (id, newsletter_id, subject, created_by, created_at, updated_at) VALUES ('cmp_legacy', ?, 'Old', 'usr_old', 1, 1)", nl.id)
  assert.equal((await owner.action('campaigns.get', { campaignId: 'cmp_legacy' })).hideUnsubscribeFooter, false)
  assert.equal((await owner.action('campaigns.list', { newsletterId: nl.id })).campaigns[0].hideUnsubscribeFooter, false)
  assert.throws(() => ctx.db.run("UPDATE campaigns SET hide_unsubscribe_footer = 2 WHERE id = 'cmp_legacy'"), /CHECK constraint failed/)
  const column = ctx.db.all<{ name: string; type: string; dflt_value: string; notnull: number }>('PRAGMA table_info(campaigns)').find((c) => c.name === 'hide_unsubscribe_footer')
  assert.deepEqual({ ...column }, { ...column, name: 'hide_unsubscribe_footer', type: 'INTEGER', dflt_value: '0', notnull: 1 })
  // The welcome switches are not campaign columns at all.
  assert.deepEqual(ctx.db.all<{ name: string }>('PRAGMA table_info(campaigns)').map((c) => c.name).filter((name) => /transactional|list_unsubscribe/.test(name)), [])
})

test('a plain campaign with the line hidden passes review and is sent without it, with both headers; an html one keeps its footer', async (t) => {
  const { install, owner, nl, ctx, accountId } = await sendableInstall()
  t.after(() => install.close())
  addContacts(ctx, nl.id, 1)
  // The welcome switches are not campaign fields: sent along, they are dropped and change nothing.
  const stray = { transactional: true, includeListUnsubscribeHeaders: false }
  const hidden = await createIssue(owner, nl.id, { subject: 'Hidden', sendFormat: 'plain', hideUnsubscribeFooter: true, ...stray })
  const shown = await createIssue(owner, nl.id, { subject: 'Shown', sendFormat: 'plain' })
  const themed = await createIssue(owner, nl.id, { subject: 'Themed', hideUnsubscribeFooter: true, ...stray })
  for (const campaign of [hidden, shown, themed]) {
    assert.equal('transactional' in campaign || 'includeListUnsubscribeHeaders' in campaign, false)
    const again = await owner.action('campaigns.update', { campaignId: campaign.id, revision: campaign.revision, ...stray } as never)
    assert.equal('transactional' in again || 'includeListUnsubscribeHeaders' in again, false)
  }
  const mail = (subject: string) => install.outbox(accountId).filter((m) => m.kind === 'campaign' && m.subject === subject).at(-1)!
  const BODY_TEXT = 'Hello Reader, this is the issue.\n\nLink 1 (https://example.com/a)'

  const preview = await owner.action('campaigns.preview', { campaignId: hidden.id })
  assert.deepEqual(preview.checks, [], 'no blocking check for the missing visible line')
  assert.equal(preview.email.text, 'Hello Reader, this is the issue.\n\nLink 1 (https://example.com/a)')
  assert.deepEqual(Object.keys(preview.email.headers), ['List-Unsubscribe', 'List-Unsubscribe-Post'])

  await owner.action('campaigns.sendTest', { campaignId: hidden.id, to: ['tester@example.com'] })
  assert.equal(mail('[Test] Hidden').text, 'Hello reader, this is the issue.\n\nLink 1 (https://example.com/a)')
  assertBothHeaders(mail('[Test] Hidden').headers, CAMPAIGN_LIST)

  for (const campaign of [hidden, shown, themed]) {
    await owner.action('campaigns.send', { campaignId: campaign.id })
    assert.equal((await drive(install, owner, campaign.id)).status, 'sent')
  }
  assert.equal(mail('Hidden').text, BODY_TEXT)
  assert.doesNotMatch(mail('Hidden').html, /Unsubscribe|\/u\//)
  assert.match(mail('Shown').text, /^Hello Reader, this is the issue\.\n\nLink 1 \(https:\/\/example\.com\/a\)\n\n--\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+$/)
  assert.match(mail('Themed').html, />Unsubscribe<\/a> · <a [^>]+>Preferences<\/a> · <a [^>]+>View on the web<\/a>/)
  assert.match(mail('Themed').text, /\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+\nPreferences: /)
  for (const subject of ['Hidden', 'Shown', 'Themed']) assertBothHeaders(mail(subject).headers, CAMPAIGN_LIST)
  assert.deepEqual(Object.keys(parseHeaders(mail('Hidden').headers)), Object.keys(parseHeaders(mail('Shown').headers)))
})

test('sequence steps: hideUnsubscribeFooter on create, addStep and updateStep, in every step list, and sent with both headers', async (t) => {
  const { install, owner, nl, accountId } = await sendableInstall()
  t.after(() => install.close())
  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'new-signup' })
  const stray = { transactional: true, includeListUnsubscribeHeaders: false }
  const sequence = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'tag', tagId: tag.id }, steps: [
    { delayDays: 1, subject: 'Day 1', doc: issueDoc() as never, sendFormat: 'plain', hideUnsubscribeFooter: true, ...stray },
    { delayDays: 2, subject: 'Day 2', doc: issueDoc() as never, sendFormat: 'plain' },
  ] })
  assert.deepEqual(sequence.steps.map((s) => s.hideUnsubscribeFooter), [true, false], 'a step shows the line unless asked otherwise')
  assert.equal(sequence.steps.some((s) => 'transactional' in s || 'includeListUnsubscribeHeaders' in s), false)
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const added = await owner.action('sequences.addStep', { ...at, delayDays: 3, subject: 'Day 3', doc: issueDoc() as never, hideUnsubscribeFooter: true, ...stray } as never)
  assert.deepEqual([added.sendFormat, added.hideUnsubscribeFooter], ['html', true])
  assert.equal((await owner.action('sequences.addStep', { ...at, delayDays: 4, subject: 'Day 4' })).hideUnsubscribeFooter, false)
  const second = sequence.steps[1]
  const updated = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: second.revision, hideUnsubscribeFooter: true, ...stray } as never)
  assert.equal(updated.hideUnsubscribeFooter, true)
  assert.equal('transactional' in updated || 'includeListUnsubscribeHeaders' in updated, false)
  const renamed = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: updated.revision, subject: 'Second day' })
  assert.equal(renamed.hideUnsubscribeFooter, true, 'omitted on update keeps the value')
  const back = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: renamed.revision, hideUnsubscribeFooter: false })
  assert.equal(back.hideUnsubscribeFooter, false)
  const flags = [true, false, true, false]
  const got = await owner.action('sequences.get', at)
  assert.deepEqual(got.steps.map((s) => s.hideUnsubscribeFooter), flags)
  assert.deepEqual((await owner.action('sequences.reorderSteps', { ...at, stepIds: got.steps.map((s) => s.id) })).steps.map((s) => s.hideUnsubscribeFooter), flags)
  assert.deepEqual((await owner.action('sequences.deleteStep', { ...at, stepId: got.steps[3].id })).steps.map((s) => s.hideUnsubscribeFooter), flags.slice(0, 3))
  assert.equal((await owner.action('campaigns.get', { campaignId: sequence.steps[0].campaignId })).hideUnsubscribeFooter, true, 'the hidden campaign of the step carries the value')
  for (const hideUnsubscribeFooter of ['true', 1, null]) {
    assert.equal((await expectError(() => owner.action('sequences.addStep', { ...at, delayDays: 5, hideUnsubscribeFooter } as never))).code, 'invalid_input')
    assert.equal((await expectError(() => owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: back.revision, hideUnsubscribeFooter } as never))).code, 'invalid_input')
    assert.equal((await expectError(() => owner.action('sequences.create', { newsletterId: nl.id, name: 'Bad', entry: { type: 'manual' }, steps: [{ delayDays: 1, hideUnsubscribeFooter }] } as never))).code, 'invalid_input')
  }

  // Activation runs the campaign review on every step: the hidden line does not block it.
  await owner.action('sequences.activate', at)
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', name: 'Ada Lovelace', tags: [tag.id] })
  for (let day = 0; day < 3; day++) { install.clock.advance(86_400_000); await install.runJobs() }
  const [hidden, shown, themed] = install.outbox(accountId).filter((m) => m.kind === 'campaign')
  assert.deepEqual([hidden.subject, shown.subject, themed.subject], ['Day 1', 'Second day', 'Day 3'])
  assert.equal(hidden.text, 'Hello Ada, this is the issue.\n\nLink 1 (https://example.com/a)')
  assert.match(shown.text, /\n\n--\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+$/)
  assert.match(themed.html, />Unsubscribe<\/a> · <a [^>]+>Preferences<\/a>/, 'an html step keeps its footer whatever the flag')
  for (const mail of [hidden, shown, themed]) assertBothHeaders(mail.headers, CAMPAIGN_LIST)
})

test('the welcome email: transactional hides the unsubscribe line, and the headers go only when transactional and told to', async (t) => {
  const { install, owner, nl, accountId } = await sendableInstall()
  t.after(() => install.close())
  const base = await owner.action('signup.get', { newsletterId: nl.id })
  await owner.action('signup.update', { newsletterId: nl.id, settings: base.settings, doubleOptIn: false })
  let revision: number | null = null
  let n = 0
  /** Save the welcome email under a fresh subject, sign a new reader up and return what they were sent. */
  const welcomed = async (options: { sendFormat?: 'html' | 'plain'; transactional?: boolean; includeListUnsubscribeHeaders?: boolean }) => {
    const subject = `Welcome ${++n}`
    const saved = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject, doc: welcomeDoc, revision, ...options })
    revision = saved.welcome!.revision
    await signup(install, nl.key, `reader${n}@example.com`)
    return { saved: saved.welcome!, mail: install.outbox(accountId).find((m) => m.subject === subject)! }
  }
  const TEXT = 'Hello Reader, welcome aboard.'

  // Defaults: a normal welcome email with its line and headers.
  const first = await welcomed({ sendFormat: 'plain' })
  assert.deepEqual([first.saved.transactional, first.saved.includeListUnsubscribeHeaders], [false, true])
  assert.equal('hideUnsubscribeFooter' in first.saved, false, 'the campaign flag is not a welcome field')
  assert.match(first.mail.text, /^Hello Reader, welcome aboard\.\n\n--\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+$/)
  assertBothHeaders(first.mail.headers, SIGNUP_LIST)

  // includeListUnsubscribeHeaders false is saved but ignored while the email is not transactional.
  const ignored = await welcomed({ includeListUnsubscribeHeaders: false })
  assert.deepEqual([ignored.saved.transactional, ignored.saved.includeListUnsubscribeHeaders, ignored.saved.sendFormat], [false, false, 'plain'])
  assert.match(ignored.mail.text, /\n\n--\nUnsubscribe: http:/)
  assertBothHeaders(ignored.mail.headers, SIGNUP_LIST)
  assertBothHeaders((await owner.action('campaigns.preview', { campaignId: ignored.saved.id })).email.headers as never && JSON.stringify((await owner.action('campaigns.preview', { campaignId: ignored.saved.id })).email.headers), /^<http:\/\/app\.example\.com\/unsubscribe-preview>$/)

  // Transactional with the headers kept (the default for includeListUnsubscribeHeaders).
  const kept = await welcomed({ transactional: true, includeListUnsubscribeHeaders: true })
  assert.deepEqual([kept.saved.transactional, kept.saved.includeListUnsubscribeHeaders], [true, true])
  assert.equal(kept.mail.text, TEXT)
  assert.doesNotMatch(kept.mail.html, /Unsubscribe|\/u\//)
  assertBothHeaders(kept.mail.headers, SIGNUP_LIST)
  const got = await owner.action('signup.get', { newsletterId: nl.id })
  assert.deepEqual([got.welcome!.transactional, got.welcome!.includeListUnsubscribeHeaders, 'hideUnsubscribeFooter' in got.welcome!], [true, true, false])

  // Transactional and told to drop them: the only email that goes out without the two headers.
  const bare = await welcomed({ includeListUnsubscribeHeaders: false })
  assert.deepEqual([bare.saved.transactional, bare.saved.includeListUnsubscribeHeaders], [true, false], 'omitted transactional keeps its value')
  assert.equal(bare.mail.text, TEXT)
  assert.deepEqual(unsubscribeHeaders(bare.mail.headers), [undefined, undefined])
  assert.deepEqual(Object.keys(parseHeaders(bare.mail.headers)).sort(), ['Auto-Submitted', 'X-MC-Account'])
  // Its test send and preview match what readers get.
  await owner.action('campaigns.sendTest', { campaignId: bare.saved.id, to: ['tester@example.com'] })
  const bareTest = install.outbox(accountId).find((m) => m.subject === '[Test] Welcome 4')!
  assert.equal(bareTest.text, 'Hello friend, welcome aboard.')
  assert.deepEqual(unsubscribeHeaders(bareTest.headers), [undefined, undefined])
  assert.ok(parseHeaders(bareTest.headers)['Feedback-ID'], 'the other headers stay')
  const barePreview = await owner.action('campaigns.preview', { campaignId: bare.saved.id })
  assert.deepEqual([barePreview.email.text, barePreview.email.headers], [TEXT, {}])

  // Html and transactional: the themed footer without the Unsubscribe and Preferences links.
  const themed = await welcomed({ sendFormat: 'html', includeListUnsubscribeHeaders: true })
  assert.match(themed.mail.html, /max-width:600px/)
  assert.match(themed.mail.html, /<p>Thanks for reading\.<\/p><p>1 Example Street<\/p><p><a [^>]+>View on the web<\/a><\/p>/)
  assert.doesNotMatch(themed.mail.html + themed.mail.text, /Unsubscribe|Preferences|\/u\//)
  assertBothHeaders(themed.mail.headers, SIGNUP_LIST)
  await owner.action('campaigns.sendTest', { campaignId: themed.saved.id, to: ['tester@example.com'] })
  const themedTest = install.outbox(accountId).find((m) => m.subject === '[Test] Welcome 5')!
  assert.doesNotMatch(themedTest.html, /Unsubscribe|Preferences/)
  assertBothHeaders(themedTest.headers, CAMPAIGN_LIST)

  // Transactional off again: the footer links and headers are back even though includeListUnsubscribeHeaders is false.
  const normal = await welcomed({ transactional: false, includeListUnsubscribeHeaders: false })
  assert.deepEqual([normal.saved.transactional, normal.saved.includeListUnsubscribeHeaders], [false, false])
  assert.match(normal.mail.html, />Unsubscribe<\/a> · <a [^>]+>Preferences<\/a> · <a [^>]+>View on the web<\/a>/)
  assertBothHeaders(normal.mail.headers, SIGNUP_LIST)
  await owner.action('campaigns.sendTest', { campaignId: normal.saved.id, to: ['tester@example.com'] })
  assertBothHeaders(install.outbox(accountId).find((m) => m.subject === '[Test] Welcome 6')!.headers, CAMPAIGN_LIST)

  // Other types are refused and save nothing.
  for (const field of ['transactional', 'includeListUnsubscribeHeaders']) for (const value of ['true', 1, null, 'no']) {
    const refused = await expectError(() => owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Bad', doc: welcomeDoc, revision, [field]: value } as never))
    assert.deepEqual([refused.code, refused.status], ['invalid_input', 400], `${field}: ${String(value)}`)
  }
  assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).welcome!.revision, revision)

  // hideUnsubscribeFooter is not a welcome field: saveWelcome drops it, and campaigns.update refuses it on the welcome campaign.
  const withFlag = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: welcomeDoc, revision, sendFormat: 'plain', hideUnsubscribeFooter: true } as never)
  assert.equal('hideUnsubscribeFooter' in withFlag.welcome!, false)
  const row = await owner.action('campaigns.get', { campaignId: withFlag.welcome!.id })
  assert.deepEqual([row.kind, row.hideUnsubscribeFooter], ['welcome', false])
  const refused = await expectError(() => owner.action('campaigns.update', { campaignId: row.id, revision: row.revision, hideUnsubscribeFooter: true }))
  assert.equal(refused.code, 'invalid_input')
  assert.equal('transactional' in row || 'includeListUnsubscribeHeaders' in row, false, 'the welcome switches are not campaign fields either')
})

test('the confirmation email of a transactional welcome keeps its headers and unsubscribe link', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: null, transactional: true, includeListUnsubscribeHeaders: false })
  await signup(install, nl.key, 'reader@example.com')
  const confirm = install.outbox(owner.accountId!).find((m) => m.subject === 'Confirm your subscription to Weekly')!
  assertBothHeaders(confirm.headers, SIGNUP_LIST)
  assert.match(confirm.html, />Unsubscribe<\/a>/)
})

test('MCP and REST: the three fields sit on exactly the tools they belong to, round-trip, and refuse other types', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const key = await owner.action('apikeys.create', { name: 'Automation', access: 'full' })
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const mcp = async (method: string, params?: unknown) => (await (await install.fetch('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
  const call = (name: string, args: Record<string, unknown>) => mcp('tools/call', { name, arguments: args })
  const rest = async (method: string, path: string, body?: unknown) => {
    const response = await install.fetch(`/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }

  // Which tools name each field anywhere in their input schema.
  const tools: { name: string; inputSchema: { properties: Record<string, { type?: string; default?: unknown }>; required?: string[] } }[] = (await mcp('tools/list')).tools
  const naming = (field: string) => tools.filter((tool) => JSON.stringify(tool.inputSchema).includes(`"${field}"`)).map((tool) => tool.name).sort()
  assert.deepEqual(naming('hideUnsubscribeFooter'), ['campaigns_create', 'campaigns_update', 'sequences_addStep', 'sequences_create', 'sequences_updateStep'])
  assert.deepEqual(naming('transactional'), ['signup_saveWelcome'])
  assert.deepEqual(naming('includeListUnsubscribeHeaders'), ['signup_saveWelcome'])
  const schema = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema
  for (const name of ['campaigns_create', 'campaigns_update', 'sequences_addStep', 'sequences_updateStep']) {
    assert.equal(schema(name).properties.hideUnsubscribeFooter.type, 'boolean', name)
    assert.equal((schema(name).required ?? []).includes('hideUnsubscribeFooter'), false, `${name}: optional`)
  }
  assert.equal(schema('campaigns_create').properties.hideUnsubscribeFooter.default, false)
  for (const field of ['transactional', 'includeListUnsubscribeHeaders']) {
    assert.equal(schema('signup_saveWelcome').properties[field].type, 'boolean')
    assert.equal((schema('signup_saveWelcome').required ?? []).includes(field), false, `${field}: optional`)
  }

  // Campaigns over MCP.
  const stray = { transactional: true, includeListUnsubscribeHeaders: false }
  const created = (await call('campaigns_create', { newsletterId: nl.id, subject: 'From MCP', ...stray })).structuredContent
  assert.equal(created.hideUnsubscribeFooter, false)
  assert.equal('transactional' in created || 'includeListUnsubscribeHeaders' in created, false)
  const updated = (await call('campaigns_update', { campaignId: created.id, revision: created.revision, sendFormat: 'plain', hideUnsubscribeFooter: true, ...stray })).structuredContent
  assert.equal(updated.hideUnsubscribeFooter, true)
  assert.equal('transactional' in updated || 'includeListUnsubscribeHeaders' in updated, false)
  assert.equal((await call('campaigns_get', { campaignId: created.id })).structuredContent.hideUnsubscribeFooter, true)
  assert.equal((await call('campaigns_list', { newsletterId: nl.id })).structuredContent.campaigns[0].hideUnsubscribeFooter, true)
  assert.equal((await call('campaigns_duplicate', { campaignId: created.id })).structuredContent.hideUnsubscribeFooter, true)
  const refused = await call('campaigns_update', { campaignId: created.id, revision: updated.revision, hideUnsubscribeFooter: 'yes' })
  assert.equal(refused.isError, true)
  assert.equal(refused.structuredContent.error.code, 'invalid_input')
  // The stray welcome switches left the campaign's preview headers alone.
  assert.deepEqual(Object.keys((await call('campaigns_preview', { campaignId: created.id })).structuredContent.email.headers), ['List-Unsubscribe', 'List-Unsubscribe-Post'])

  // Campaigns over REST.
  const posted = await rest('POST', `/newsletters/${nl.id}/campaigns`, { subject: 'From REST', sendFormat: 'plain', hideUnsubscribeFooter: true, ...stray })
  assert.deepEqual([posted.status, posted.body.hideUnsubscribeFooter, 'transactional' in posted.body], [200, true, false])
  const patched = await rest('PATCH', `/campaigns/${posted.body.id}`, { revision: posted.body.revision, hideUnsubscribeFooter: false })
  assert.deepEqual([patched.status, patched.body.hideUnsubscribeFooter], [200, false])
  assert.equal((await rest('GET', `/campaigns/${posted.body.id}`)).body.hideUnsubscribeFooter, false)
  assert.equal((await rest('GET', `/newsletters/${nl.id}/campaigns`)).body.campaigns.every((c: Record<string, unknown>) => typeof c.hideUnsubscribeFooter === 'boolean'), true)
  const badPatch = await rest('PATCH', `/campaigns/${posted.body.id}`, { revision: patched.body.revision, hideUnsubscribeFooter: 'true' })
  assert.deepEqual([badPatch.status, badPatch.body.error.code], [400, 'invalid_input'])
  const badPost = await rest('POST', `/newsletters/${nl.id}/campaigns`, { hideUnsubscribeFooter: 1 })
  assert.deepEqual([badPost.status, badPost.body.error.code], [400, 'invalid_input'])

  // Sequence steps over MCP and REST.
  const sequence = (await call('sequences_create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'manual' }, steps: [{ delayDays: 1, subject: 'Day 1', sendFormat: 'plain', hideUnsubscribeFooter: true }] })).structuredContent
  assert.equal(sequence.steps[0].hideUnsubscribeFooter, true)
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const step = (await call('sequences_addStep', { ...at, delayDays: 2, subject: 'Day 2', ...stray })).structuredContent
  assert.equal(step.hideUnsubscribeFooter, false)
  assert.equal('transactional' in step || 'includeListUnsubscribeHeaders' in step, false)
  const saved = (await call('sequences_updateStep', { ...at, stepId: step.id, revision: step.revision, hideUnsubscribeFooter: true })).structuredContent
  assert.equal(saved.hideUnsubscribeFooter, true)
  assert.deepEqual((await call('sequences_get', at)).structuredContent.steps.map((s: { hideUnsubscribeFooter: boolean }) => s.hideUnsubscribeFooter), [true, true])
  assert.equal((await call('sequences_updateStep', { ...at, stepId: step.id, revision: saved.revision, hideUnsubscribeFooter: 0 })).structuredContent.error.code, 'invalid_input')
  const stepsPath = `/newsletters/${nl.id}/sequences/${sequence.id}`
  const restStep = await rest('POST', `${stepsPath}/steps`, { delayDays: 3, subject: 'Day 3', hideUnsubscribeFooter: true })
  assert.deepEqual([restStep.status, restStep.body.hideUnsubscribeFooter], [200, true])
  const restSaved = await rest('PATCH', `${stepsPath}/steps/${restStep.body.id}`, { revision: restStep.body.revision, hideUnsubscribeFooter: false })
  assert.deepEqual([restSaved.status, restSaved.body.hideUnsubscribeFooter], [200, false])
  assert.deepEqual((await rest('GET', stepsPath)).body.steps.map((s: { hideUnsubscribeFooter: boolean }) => s.hideUnsubscribeFooter), [true, true, false])
  const badStep = await rest('POST', `${stepsPath}/steps`, { delayDays: 4, hideUnsubscribeFooter: 'no' })
  assert.deepEqual([badStep.status, badStep.body.error.code], [400, 'invalid_input'])

  // The welcome email over MCP.
  const welcome = (await call('signup_saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: null })).structuredContent.welcome
  assert.deepEqual([welcome.transactional, welcome.includeListUnsubscribeHeaders, 'hideUnsubscribeFooter' in welcome], [false, true, false])
  const transactional = (await call('signup_saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: welcome.revision, transactional: true, includeListUnsubscribeHeaders: false })).structuredContent.welcome
  assert.deepEqual([transactional.transactional, transactional.includeListUnsubscribeHeaders], [true, false])
  const read = (await call('signup_get', { newsletterId: nl.id })).structuredContent.welcome
  assert.deepEqual([read.transactional, read.includeListUnsubscribeHeaders], [true, false])
  const badWelcome = await call('signup_saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: transactional.revision, transactional: 'yes' })
  assert.equal(badWelcome.structuredContent.error.code, 'invalid_input')

  // The welcome email over REST.
  const put = await rest('PUT', `/newsletters/${nl.id}/signup/welcome`, { enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: transactional.revision, includeListUnsubscribeHeaders: true })
  assert.deepEqual([put.status, put.body.welcome.transactional, put.body.welcome.includeListUnsubscribeHeaders], [200, true, true])
  const fetched = await rest('GET', `/newsletters/${nl.id}/signup`)
  assert.deepEqual([fetched.status, fetched.body.welcome.transactional, fetched.body.welcome.includeListUnsubscribeHeaders], [200, true, true])
  for (const bad of [{ transactional: 1 }, { includeListUnsubscribeHeaders: 'false' }]) {
    const refusedPut = await rest('PUT', `/newsletters/${nl.id}/signup/welcome`, { enabled: true, subject: 'Welcome', doc: welcomeDoc, revision: put.body.welcome.revision, ...bad })
    assert.deepEqual([refusedPut.status, refusedPut.body.error.code], [400, 'invalid_input'])
  }
})
