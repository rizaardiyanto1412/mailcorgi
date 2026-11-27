/** Plain send mode (`sendFormat: 'plain'`): rendering, the MIME parts each provider sends, and the field on every action. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP_URL, createInstall, expectError, type Install } from './harness.ts'
import { addContacts, createIssue, drive, issueDoc, LINK_A, parseHeaders, sendableInstall } from './sending-setup.ts'
import { renderEmail, type RenderCampaign } from '../account/render/index.ts'
import { reviewChecks } from '../account/campaigns/index.ts'
import { buildMime } from '../email/mime.ts'
import { sesProvider } from '../email/ses.ts'
import { resendProvider } from '../email/resend.ts'
import { postshibaProvider } from '../email/postshiba.ts'
import type { EmailMessage } from '../email/index.ts'

const UNSUBSCRIBE = 'https://app.example.com/u/token'
const links = { unsubscribe: UNSUBSCRIBE, preferences: 'https://app.example.com/u/prefs', web: 'https://app.example.com/n/weekly/issue' }
const contact = { name: 'Ada Lovelace', email: 'ada@example.com', fields: { plan: 'pro' } }
const newsletter = { name: 'Weekly', postalAddress: '1 Example Street' }
const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (value: string, href?: string) => ({ type: 'text', text: value, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) })
const personalDoc = { type: 'doc', content: [
  para(text('Hi {{first_name|there}},')),
  para(text('Thanks for joining. Your plan is {{field.plan}}. Read '), text('the guide', 'https://example.com/guide?a=1&b=2'), text(' first.')),
  para(text('https://example.com/bare', 'https://example.com/bare')),
  para(text('Riza')),
] }
const render = (campaign: RenderCampaign, extra: Partial<typeof links> & { openPixel?: string; wrap?(url: string): string } = {}) =>
  renderEmail({ campaign: { subject: 'Welcome, {{first_name}}', previewText: 'Hidden preview', ...campaign }, newsletter, theme: {}, recipient: { contact, links: { ...links, ...extra } } })
/** Markup only the themed email carries: the card, the footer, the preview text and the open pixel. */
const assertNoTheme = (value: string) => {
  for (const mark of ['600', 'Thanks for reading', 'Preferences', 'View on the web', 'Hidden preview', '1 Example Street', 'width="1"', '/t/o/', '/t/c/', 'style=', '<table']) assert.equal(value.includes(mark), false, `found ${mark}`)
}
const message: EmailMessage = { from: 'Riza <riza@example.com>', to: 'reader@example.com', subject: 'Welcome', text: 'Hi there,\n\nThanks for joining.\n\n--\nUnsubscribe: https://app.example.com/u/token', html: '<!doctype html><html><body><p>Hi there,</p></body></html>', textOnly: true, headers: { 'List-Unsubscribe': `<${UNSUBSCRIBE}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, meta: { accountId: 'acc_example', deliveryId: '42', kind: 'campaign' }, idempotencyKey: 'delivery-42' }

async function signup(install: Install, key: string, email = 'reader@example.com') {
  const config: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${key}`)).json()
  install.clock.advance(2001)
  return install.app.edge.fetch(new Request(`${APP_URL}/api/public/subscribe/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Reader', formToken: config.formToken }) }), '192.0.2.1')
}

test('a plain email is the words alone: paragraphs, merged fields, links written out and one unsubscribe line', () => {
  const plain = render({ format: 'doc', doc: personalDoc, sendFormat: 'plain' }, { openPixel: 'https://app.example.com/t/o/pixel', wrap: () => 'https://app.example.com/t/c/click' })
  assert.equal(plain.text, [
    'Hi Ada,',
    'Thanks for joining. Your plan is pro. Read the guide (https://example.com/guide?a=1&b=2) first.',
    'https://example.com/bare',
    'Riza',
    `--\nUnsubscribe: ${UNSUBSCRIBE}`,
  ].join('\n\n'))
  assert.equal(plain.subject, 'Welcome, Ada')
  assert.equal(plain.textOnly, true)
  assertNoTheme(plain.text)
  // The HTML copy is for a provider that needs an HTML part: the same paragraphs and nothing else.
  assertNoTheme(plain.html)
  assert.equal(plain.html, `<!doctype html><html><body><p>Hi Ada,</p><p>Thanks for joining. Your plan is pro. Read the guide (<a href="https://example.com/guide?a=1&amp;b=2">https://example.com/guide?a=1&amp;b=2</a>) first.</p><p><a href="https://example.com/bare">https://example.com/bare</a></p><p>Riza</p><p>--<br>Unsubscribe: <a href="${UNSUBSCRIBE}">${UNSUBSCRIBE}</a></p></body></html>`)
})

test('plain and html sends carry the same List-Unsubscribe headers, and html stays the default', () => {
  const html = render({ format: 'doc', doc: personalDoc })
  const plain = render({ format: 'doc', doc: personalDoc, sendFormat: 'plain' })
  assert.deepEqual(plain.headers, html.headers)
  assert.deepEqual(plain.headers, { 'List-Unsubscribe': `<${UNSUBSCRIBE}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
  // No send format, an unknown one and a stored row's `send_format: 'html'` all render the themed email.
  for (const campaign of [{}, { sendFormat: 'html' }, { send_format: 'html' }, { sendFormat: 'other' }]) {
    const themed = render({ format: 'doc', doc: personalDoc, ...campaign })
    assert.equal(themed.textOnly, undefined)
    assert.match(themed.html, /max-width:600px/)
    assert.match(themed.html, /Thanks for reading/)
    assert.match(themed.text, /\[1\] https:\/\/example\.com\/guide/)
  }
  assert.equal(render({ format: 'doc', doc: personalDoc, send_format: 'plain' }).textOnly, true)
})

test('Markdown and HTML content become readable plain text', () => {
  const markdown = render({ format: 'markdown', sendFormat: 'plain', source: '# Hello {{first_name}}\n\nFirst **bold** paragraph with [a link](https://example.com/a).\n\n- one\n- two\n\nLast paragraph.' })
  assert.equal(markdown.text, `Hello Ada\n\nFirst bold paragraph with a link (https://example.com/a).\n\n- one\n- two\n\nLast paragraph.\n\n--\nUnsubscribe: ${UNSUBSCRIBE}`)
  const html = render({ format: 'html', sendFormat: 'plain', html: '<div style="background:#eee">\n  <h1>Hello {{first_name}}</h1>\n  <p>First <b>bold</b> paragraph<br>with <a href="https://example.com/a?x=1&amp;y=2">a link</a>.</p>\n  <p><a href="https://example.com/b">https://example.com/b</a></p>\n  <p>Tom &amp; Jerry</p>\n  <script>alert(1)</script>\n</div>' }, { wrap: () => 'https://app.example.com/t/c/click' })
  assert.equal(html.text, `Hello Ada\n\nFirst bold paragraph\nwith a link (https://example.com/a?x=1&y=2).\n\nhttps://example.com/b\n\nTom & Jerry\n\n--\nUnsubscribe: ${UNSUBSCRIBE}`)
  assertNoTheme(html.html)
  assert.equal(html.html.includes('background'), false, 'the raw HTML design is not sent')
  // An author's own plain text alternative is used as written.
  const own = render({ format: 'html', sendFormat: 'plain', html: '<p>Ignored</p>', text: 'Dear {{first_name}},\n\nMy own words.' })
  assert.equal(own.text, `Dear Ada,\n\nMy own words.\n\n--\nUnsubscribe: ${UNSUBSCRIBE}`)
})

test('review checks do not ask a plain email for preview text or an unsubscribe link in its HTML', () => {
  const ids = (campaign: Record<string, unknown>) => reviewChecks({ campaign: { subject: 'Hello', format: 'html', html: '<p>Hello</p>', ...campaign }, newsletter, theme: {}, domainVerified: true }).map((check) => check.id)
  assert.deepEqual(ids({}), ['preview_text', 'unsubscribe'])
  assert.deepEqual(ids({ sendFormat: 'plain' }), [])
})

test('raw MIME for SES and SMTP is a single text/plain entity for a plain send', () => {
  const mime = buildMime(message)
  const [head, body] = mime.split('\r\n\r\n')
  assert.match(head, /^Content-Type: text\/plain; charset=UTF-8$/m)
  assert.match(head, /^Content-Transfer-Encoding: base64$/m)
  assert.match(head, /^List-Unsubscribe: <https:\/\/app\.example\.com\/u\/token>$/m)
  assert.match(head, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)
  assert.doesNotMatch(mime, /multipart|text\/html|boundary/)
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), message.text.replace(/\n/g, '\r\n'))
  assert.equal(mime.split('\r\n\r\n').length, 2, 'one body, no parts')
  // Without the flag the message is the two-part alternative it always was.
  const both = buildMime({ ...message, textOnly: undefined })
  assert.match(both, /multipart\/alternative;\s+boundary=/)
  assert.match(both, /Content-Type: text\/html; charset=UTF-8/)
})

test('SES, Resend and PostShiba send text/plain only for a plain send', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const calls: Request[] = []
  let reply: () => Response = () => Response.json({ MessageId: 'ses-1' })
  ctx.platform.fetch = async (input, init) => { calls.push(new Request(input, init)); return reply() }

  assert.deepEqual(await sesProvider(ctx, { ses_access_key_id: 'placeholder-id', ses_secret_access_key: 'placeholder-secret' }).send(message), { ok: true, id: 'ses-1' })
  const raw = Buffer.from((await calls[0].json()).Content.Raw.Data, 'base64').toString()
  assert.match(raw, /^Content-Type: text\/plain; charset=UTF-8$/m)
  assert.doesNotMatch(raw, /multipart|text\/html/)
  assert.match(raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)

  reply = () => Response.json({ id: 'resend-1' })
  assert.deepEqual(await resendProvider(ctx, { resend_api_key: 'placeholder-key' }).send(message), { ok: true, id: 'resend-1' })
  const resend = await calls[1].json()
  assert.equal(resend.text, message.text)
  assert.equal('html' in resend, false)
  assert.equal(resend.headers['List-Unsubscribe'], `<${UNSUBSCRIBE}>`)
  assert.equal(resend.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  await resendProvider(ctx, { resend_api_key: 'placeholder-key' }).send({ ...message, textOnly: undefined })
  assert.equal((await calls[2].json()).html, message.html, 'an html send still carries its HTML')

  reply = () => Response.json({ success_count: 1, fail_count: 0, failed_recipients: [], errors: [] })
  assert.equal((await postshibaProvider(ctx, { postshiba_user: 'smtp_fixture', postshiba_password: 'placeholder-password' }).send(message)).ok, true)
  const inject = (await calls[3].json()).content
  assert.equal(inject.text_body, message.text)
  assert.equal('html_body' in inject, false)
  assert.equal(inject.headers['List-Unsubscribe'], `<${UNSUBSCRIBE}>`)
  assert.equal(inject.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  await postshibaProvider(ctx, { postshiba_user: 'smtp_fixture', postshiba_password: 'placeholder-password' }).send({ ...message, textOnly: undefined })
  assert.equal((await calls[4].json()).content.html_body, message.html, 'an html send still carries its HTML')
})

test('a plain campaign goes out untracked with the html headers, and its test send is plain too', async (t) => {
  const { install, owner, nl, ctx, accountId } = await sendableInstall()
  t.after(() => install.close())
  const [reader] = addContacts(ctx, nl.id, 1)
  const themed = await createIssue(owner, nl.id)
  const plain = await createIssue(owner, nl.id, { subject: 'A note', sendFormat: 'plain' })
  assert.equal(plain.sendFormat, 'plain')
  const campaignMail = () => install.outbox(accountId).filter((m) => m.kind === 'campaign')

  assert.deepEqual(await owner.action('campaigns.sendTest', { campaignId: plain.id, to: ['tester@example.com'] }), { sent: ['tester@example.com'], failed: [] })
  const testMail = campaignMail().at(-1)!
  assert.equal(testMail.subject, '[Test] A note')
  assert.match(testMail.text, /^Hello reader, this is the issue\.\n\nLink 1 \(https:\/\/example\.com\/a\)\n\n--\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+$/)
  assertNoTheme(testMail.text)
  assertNoTheme(testMail.html)

  const preview = await owner.action('campaigns.preview', { campaignId: plain.id })
  assertNoTheme(preview.email.html)
  assert.deepEqual(preview.checks, [])

  await owner.action('campaigns.send', { campaignId: themed.id })
  assert.equal((await drive(install, owner, themed.id)).status, 'sent')
  const streak = () => ctx.db.get<{ n: number }>('SELECT ignored_streak AS n FROM contacts WHERE id = ?', reader)!.n
  assert.equal(streak(), 1)
  await owner.action('campaigns.send', { campaignId: plain.id })
  assert.equal((await drive(install, owner, plain.id)).status, 'sent')
  const [htmlMail, plainMail] = campaignMail().filter((m) => m.to_email === 'reader0@example.com')
  assert.match(htmlMail.html, /max-width:600px/)
  assert.match(htmlMail.html, /\/t\/o\//)
  assert.match(htmlMail.html, /\/t\/c\//)
  assert.match(plainMail.text, /^Hello Reader, this is the issue\.\n\nLink 1 \(https:\/\/example\.com\/a\)\n\n--\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+$/)
  assertNoTheme(plainMail.text)
  assertNoTheme(plainMail.html)
  assert.ok(plainMail.html.includes(`<a href="${LINK_A}">${LINK_A}</a>`), 'the link is the address itself, not a click-tracking one')

  // The headers are the html send's, apart from the ids and tokens of the campaign and delivery.
  const shape = (raw: string) => Object.fromEntries(Object.entries(parseHeaders(raw)).map(([key, value]) => [key, value.replace(/\/u\/[\w.-]+/, '/u/TOKEN').replace(/cmp_\w+/, 'CAMPAIGN')]).filter(([key]) => key !== 'X-MC-Delivery'))
  assert.deepEqual(shape(plainMail.headers), shape(htmlMail.headers))
  const headers = parseHeaders(plainMail.headers)
  assert.match(headers['List-Unsubscribe'], /^<mailto:unsubscribe@example\.com\?subject=unsubscribe>, <http:\/\/app\.example\.com\/u\/[\w.-]+>$/)
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.ok(plainMail.text.endsWith(/<(http[^>]+)>$/.exec(headers['List-Unsubscribe'])![1]), 'the unsubscribe line is the one-click address')

  const links = (campaignId: string) => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM links WHERE campaign_id = ?', campaignId)!.n
  assert.deepEqual([links(themed.id), links(plain.id)], [1, 0])
  assert.equal(streak(), 1, 'a plain send has no open pixel, so it never counts as an ignored issue')
})

test('campaigns: sendFormat defaults to html, round-trips through create, update, get, list and duplicate, and rejects other values', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'One' })
  assert.equal(draft.sendFormat, 'html')
  assert.equal(draft.format, 'doc', 'the content format is a separate field')
  const plain = await owner.action('campaigns.update', { campaignId: draft.id, revision: draft.revision, sendFormat: 'plain' })
  assert.equal(plain.sendFormat, 'plain')
  assert.equal((await owner.action('campaigns.get', { campaignId: draft.id })).sendFormat, 'plain')
  const kept = await owner.action('campaigns.update', { campaignId: draft.id, revision: plain.revision, subject: 'Renamed' })
  assert.equal(kept.sendFormat, 'plain', 'omitted on update keeps the value')
  assert.equal((await owner.action('campaigns.duplicate', { campaignId: draft.id })).sendFormat, 'plain')
  const created = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Two', sendFormat: 'plain', format: 'markdown', source: 'Hello' })
  assert.deepEqual([created.sendFormat, created.format], ['plain', 'markdown'])
  const back = await owner.action('campaigns.update', { campaignId: created.id, revision: created.revision, sendFormat: 'html' })
  assert.equal(back.sendFormat, 'html')
  const list = await owner.action('campaigns.list', { newsletterId: nl.id })
  assert.deepEqual(Object.fromEntries(list.campaigns.map((c) => [c.subject, c.sendFormat])), { Renamed: 'plain', 'Renamed (copy)': 'plain', Two: 'html' })
  for (const sendFormat of ['text', 'PLAIN', '', null, 1]) {
    assert.equal((await expectError(() => owner.action('campaigns.create', { newsletterId: nl.id, sendFormat } as never))).code, 'invalid_input')
    assert.equal((await expectError(() => owner.action('campaigns.update', { campaignId: draft.id, revision: kept.revision, sendFormat } as never))).code, 'invalid_input')
  }
  assert.equal((await owner.action('campaigns.get', { campaignId: draft.id })).revision, kept.revision, 'a rejected value saves nothing')
})

test('a campaign row written before the column existed reads as html', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const ctx = install.app.account(owner.accountId!).ctx
  ctx.db.run("INSERT INTO campaigns (id, newsletter_id, subject, created_by, created_at, updated_at) VALUES ('cmp_legacy', ?, 'Old', 'usr_old', 1, 1)", nl.id)
  assert.equal((await owner.action('campaigns.get', { campaignId: 'cmp_legacy' })).sendFormat, 'html')
  assert.throws(() => ctx.db.run("UPDATE campaigns SET send_format = 'rich' WHERE id = 'cmp_legacy'"), /CHECK constraint failed/)
  const column = ctx.db.all<{ name: string; dflt_value: string; notnull: number }>('PRAGMA table_info(campaigns)').find((c) => c.name === 'send_format')
  assert.deepEqual({ ...column }, { ...column, name: 'send_format', dflt_value: "'html'", notnull: 1 })
})

test('the welcome email: sendFormat saves, reads back from signup.get, keeps its value when omitted and is sent as plain text', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  await owner.action('newsletters.update', { newsletterId: nl.id, postalAddress: '1 Example Street' })
  const base = await owner.action('signup.get', { newsletterId: nl.id })
  assert.equal(base.welcome, null)
  await owner.action('signup.update', { newsletterId: nl.id, settings: base.settings, doubleOptIn: false })
  const doc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Hello {{first_name|friend}}, welcome aboard.' }] }, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Reply any time.' }] }] }
  const first = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc, revision: null })
  assert.equal(first.welcome!.sendFormat, 'html', 'a new welcome email is html unless asked otherwise')
  const plain = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc, revision: first.welcome!.revision, sendFormat: 'plain' })
  assert.equal(plain.welcome!.sendFormat, 'plain')
  assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).welcome!.sendFormat, 'plain')
  const kept = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome!', doc, revision: plain.welcome!.revision })
  assert.equal(kept.welcome!.sendFormat, 'plain', 'omitted keeps the value')
  const invalid = await expectError(() => owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc, revision: kept.welcome!.revision, sendFormat: 'text' } as never))
  assert.equal(invalid.code, 'invalid_input')
  assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).welcome!.revision, kept.welcome!.revision)

  assert.equal((await signup(install, nl.key)).status, 200)
  await install.runJobs()
  const mail = install.outbox(owner.accountId!).find((m) => m.subject === 'Welcome!')!
  assert.match(mail.text, /^Hello Reader, welcome aboard\.\n\nReply any time\.\n\n--\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+$/)
  assertNoTheme(mail.text)
  assertNoTheme(mail.html)
  const headers = parseHeaders(mail.headers)
  assert.match(headers['List-Unsubscribe'], /^<http:\/\/app\.example\.com\/u\/[\w.-]+>$/)
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  // The provider is told the message is text only: the snapshot it sends from carries the flag.
  const sent = ctx(install, owner.accountId!).db.get<{ message: string }>("SELECT message FROM signup_mail WHERE kind = 'welcome'")!
  assert.equal(JSON.parse(sent.message).textOnly, true)

  // Back to html: the next reader gets the themed email with the same headers.
  await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Themed', doc, revision: kept.welcome!.revision, sendFormat: 'html' })
  assert.equal((await signup(install, nl.key, 'second@example.com')).status, 200)
  await install.runJobs()
  const themed = install.outbox(owner.accountId!).find((m) => m.subject === 'Themed')!
  assert.match(themed.html, /max-width:600px/)
  assert.match(themed.text, /Thanks for reading/)
  assert.deepEqual(Object.keys(parseHeaders(themed.headers)), Object.keys(headers))
  assert.equal(parseHeaders(themed.headers)['List-Unsubscribe-Post'], headers['List-Unsubscribe-Post'])
})
const ctx = (install: Install, accountId: string) => install.app.account(accountId).ctx

test('sequence steps: sendFormat on create, addStep and updateStep, in get and step lists, and a plain step is sent as plain text', async (t) => {
  const { install, owner, nl, accountId } = await sendableInstall()
  t.after(() => install.close())
  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'new-signup' })
  const sequence = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'tag', tagId: tag.id }, steps: [
    { delayDays: 1, subject: 'Day 1', doc: issueDoc() as never, sendFormat: 'plain' },
    { delayDays: 2, subject: 'Day 2', doc: issueDoc() as never },
  ] })
  assert.deepEqual(sequence.steps.map((s) => s.sendFormat), ['plain', 'html'], 'a step is html unless asked otherwise')
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const added = await owner.action('sequences.addStep', { ...at, delayDays: 3, subject: 'Day 3', sendFormat: 'plain' })
  assert.equal(added.sendFormat, 'plain')
  assert.equal((await owner.action('sequences.addStep', { ...at, delayDays: 4, subject: 'Day 4' })).sendFormat, 'html')
  const second = sequence.steps[1]
  const updated = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: second.revision, sendFormat: 'plain' })
  assert.equal(updated.sendFormat, 'plain')
  const renamed = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: updated.revision, subject: 'Second day' })
  assert.equal(renamed.sendFormat, 'plain', 'omitted on update keeps the value')
  const back = await owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: renamed.revision, sendFormat: 'html' })
  assert.equal(back.sendFormat, 'html')
  assert.deepEqual((await owner.action('sequences.get', at)).steps.map((s) => s.sendFormat), ['plain', 'html', 'plain', 'html'])
  assert.deepEqual((await owner.action('sequences.reorderSteps', { ...at, stepIds: (await owner.action('sequences.get', at)).steps.map((s) => s.id) })).steps.map((s) => s.sendFormat), ['plain', 'html', 'plain', 'html'])
  // The step's hidden campaign carries the same value, so the campaign editor and the send path agree.
  assert.equal((await owner.action('campaigns.get', { campaignId: sequence.steps[0].campaignId })).sendFormat, 'plain')
  for (const sendFormat of ['text', '', null]) {
    assert.equal((await expectError(() => owner.action('sequences.addStep', { ...at, delayDays: 5, sendFormat } as never))).code, 'invalid_input')
    assert.equal((await expectError(() => owner.action('sequences.updateStep', { ...at, stepId: second.id, revision: back.revision, sendFormat } as never))).code, 'invalid_input')
    assert.equal((await expectError(() => owner.action('sequences.create', { newsletterId: nl.id, name: 'Bad', entry: { type: 'manual' }, steps: [{ delayDays: 1, sendFormat }] } as never))).code, 'invalid_input')
  }

  await owner.action('sequences.activate', at)
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', name: 'Ada Lovelace', tags: [tag.id] })
  const step = async () => { install.clock.advance(86_400_000); await install.runJobs() }
  await step()
  await step()
  const [plainMail, htmlMail] = install.outbox(accountId).filter((m) => m.kind === 'campaign')
  assert.deepEqual([plainMail.subject, htmlMail.subject], ['Day 1', 'Second day'])
  assert.match(plainMail.text, /^Hello Ada, this is the issue\.\n\nLink 1 \(https:\/\/example\.com\/a\)\n\n--\nUnsubscribe: http:\/\/app\.example\.com\/u\/[\w.-]+$/)
  assertNoTheme(plainMail.text)
  assertNoTheme(plainMail.html)
  assert.match(htmlMail.html, /max-width:600px/)
  assert.deepEqual(Object.keys(parseHeaders(plainMail.headers)), Object.keys(parseHeaders(htmlMail.headers)))
  assert.match(parseHeaders(plainMail.headers)['List-Unsubscribe'], /^<mailto:unsubscribe@example\.com\?subject=unsubscribe>, <http:\/\/app\.example\.com\/u\/[\w.-]+>$/)
  assert.equal(parseHeaders(plainMail.headers)['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
})

test('MCP tools take and return sendFormat, list it in their schemas and refuse other values', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const key = await owner.action('apikeys.create', { name: 'Automation', access: 'full' })
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const mcp = async (method: string, params?: unknown) => (await (await install.fetch('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
  const call = (name: string, args: Record<string, unknown>) => mcp('tools/call', { name, arguments: args })

  const tools: { name: string; inputSchema: { properties: Record<string, { enum?: string[]; default?: string }>; required?: string[] } }[] = (await mcp('tools/list')).tools
  for (const name of ['campaigns_create', 'campaigns_update', 'signup_saveWelcome', 'sequences_addStep', 'sequences_updateStep']) {
    const schema = tools.find((tool) => tool.name === name)!.inputSchema
    assert.deepEqual(schema.properties.sendFormat.enum, ['html', 'plain'], name)
    assert.equal((schema.required ?? []).includes('sendFormat'), false, `${name}: sendFormat is optional`)
  }
  assert.equal(tools.find((tool) => tool.name === 'campaigns_create')!.inputSchema.properties.sendFormat.default, 'html')

  const created = await call('campaigns_create', { newsletterId: nl.id, subject: 'From MCP' })
  assert.equal(created.structuredContent.sendFormat, 'html')
  const updated = await call('campaigns_update', { campaignId: created.structuredContent.id, revision: created.structuredContent.revision, sendFormat: 'plain' })
  assert.equal(updated.structuredContent.sendFormat, 'plain')
  assert.equal((await call('campaigns_get', { campaignId: created.structuredContent.id })).structuredContent.sendFormat, 'plain')
  assert.equal((await call('campaigns_list', { newsletterId: nl.id })).structuredContent.campaigns[0].sendFormat, 'plain')
  const refused = await call('campaigns_update', { campaignId: created.structuredContent.id, revision: updated.structuredContent.revision, sendFormat: 'text' })
  assert.equal(refused.isError, true)
  assert.equal(refused.structuredContent.error.code, 'invalid_input')

  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Welcome aboard.' }] }] }
  const welcome = await call('signup_saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc, revision: null, sendFormat: 'plain' })
  assert.equal(welcome.structuredContent.welcome.sendFormat, 'plain')
  assert.equal((await call('signup_get', { newsletterId: nl.id })).structuredContent.welcome.sendFormat, 'plain')
  const badWelcome = await call('signup_saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc, revision: welcome.structuredContent.welcome.revision, sendFormat: 'markdown' })
  assert.equal(badWelcome.structuredContent.error.code, 'invalid_input')

  const sequence = await call('sequences_create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'manual' }, steps: [{ delayDays: 1, subject: 'Day 1', sendFormat: 'plain' }] })
  assert.equal(sequence.structuredContent.steps[0].sendFormat, 'plain')
  const at = { newsletterId: nl.id, sequenceId: sequence.structuredContent.id }
  const step = await call('sequences_addStep', { ...at, delayDays: 2, subject: 'Day 2' })
  assert.equal(step.structuredContent.sendFormat, 'html')
  const saved = await call('sequences_updateStep', { ...at, stepId: step.structuredContent.id, revision: step.structuredContent.revision, sendFormat: 'plain' })
  assert.equal(saved.structuredContent.sendFormat, 'plain')
  assert.deepEqual((await call('sequences_get', at)).structuredContent.steps.map((s: { sendFormat: string }) => s.sendFormat), ['plain', 'plain'])
  const badStep = await call('sequences_updateStep', { ...at, stepId: step.structuredContent.id, revision: saved.structuredContent.revision, sendFormat: 'rich' })
  assert.equal(badStep.structuredContent.error.code, 'invalid_input')
})
