/**
 * Update actions keep what the caller leaves out. Defaults belong to creating a resource, never to saving an existing one:
 * a client that sends only the field it changes (over REST, MCP or the action client) must not reset the rest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Install } from './harness.ts'
import { sendableInstall } from './sending-setup.ts'
import { transitionCampaign } from '../account/campaigns/index.ts'
import { defaultTheme } from '../account/render/index.ts'

const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] })
const emptyBody = { type: 'doc', content: [{ type: 'paragraph' }] }

/** An install with an owner, a newsletter and the same call made over the action client, REST and MCP. */
async function setup(t: { after(fn: () => void): void }, make: () => Promise<{ install: Install; owner: Awaited<ReturnType<Install['signUp']>>; nl: { id: string; key: string } }>) {
  const { install, owner, nl } = await make()
  t.after(() => install.close())
  const key = await owner.action('apikeys.create', { name: 'Automation', access: 'full' })
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const mcpCall = async (method: string, params?: unknown) => (await (await install.fetch('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const result = await mcpCall('tools/call', { name, arguments: args })
    return { isError: !!result.isError, out: result.structuredContent }
  }
  const rest = async (method: string, path: string, body?: unknown) => {
    const response = await install.fetch(`/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  return { install, owner, nl, mcp, rest, headers, tools: async () => (await mcpCall('tools/list')).tools as { name: string; inputSchema: Record<string, any> }[] }
}
const plain = () => createInstall().then(async (install) => {
  const owner = await install.signUp({ email: 'owner@example.com' })
  return { install, owner, nl: await owner.action('newsletters.create', { name: 'Weekly' }) }
})

test('signup.saveWelcome: a new welcome email gets the first-time defaults', async (t) => {
  const { owner, nl } = await setup(t, plain)
  const created = await owner.action('signup.saveWelcome', { newsletterId: nl.id, subject: 'Welcome', revision: null })
  assert.equal(created.enabled, false, 'a new welcome email starts off')
  assert.deepEqual(created.welcome!.doc, emptyBody)
  assert.equal(created.welcome!.subject, 'Welcome')
  assert.equal(created.welcome!.sendFormat, 'html')
  assert.equal(created.welcome!.transactional, false)
  assert.equal(created.welcome!.includeListUnsubscribeHeaders, true)
  assert.deepEqual([created.welcome!.fromDomainId, created.welcome!.fromLocal, created.welcome!.fromName], [null, null, null])
  assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).welcomeEnabled, false)
  // Creating still needs a subject.
  const other = await owner.action('newsletters.create', { name: 'Other' })
  const refused = await expectError(() => owner.action('signup.saveWelcome', { newsletterId: other.id, revision: null }))
  assert.equal(refused.code, 'invalid_input')
  assert.equal((await owner.action('signup.get', { newsletterId: other.id })).welcome, null)
})

test('signup.saveWelcome: omitted fields keep their stored value, and sending one changes only that one', async (t) => {
  const { owner, nl } = await setup(t, () => sendableInstall().then(({ install, owner, nl }) => ({ install, owner, nl })))
  const domain = (await owner.action('domains.list', {}))[0]
  let saved = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Hello', doc: doc('Original body'), revision: null, sendFormat: 'plain', transactional: true, includeListUnsubscribeHeaders: false, fromDomainId: domain.id, fromLocal: 'hi', fromName: 'Riza' })
  const state = (r: typeof saved) => ({ enabled: r.enabled, subject: r.welcome!.subject, doc: r.welcome!.doc, sendFormat: r.welcome!.sendFormat, transactional: r.welcome!.transactional, headers: r.welcome!.includeListUnsubscribeHeaders, sender: [r.welcome!.fromDomainId, r.welcome!.fromLocal, r.welcome!.fromName] as (string | null)[] })
  const full: ReturnType<typeof state> = state(saved)
  assert.deepEqual(full, { enabled: true, subject: 'Hello', doc: doc('Original body'), sendFormat: 'plain', transactional: true, headers: false, sender: [domain.id, 'hi', 'Riza'] })

  // Nothing but the revision: nothing changes.
  saved = await owner.action('signup.saveWelcome', { newsletterId: nl.id, revision: saved.welcome!.revision })
  assert.deepEqual(state(saved), full)
  assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).welcomeEnabled, true)

  // Each field alone changes only itself, and a later omission does not revert it.
  const change: [string, Record<string, unknown>, Partial<Record<keyof typeof full, unknown>>][] = [
    ['doc', { doc: doc('New body') }, { doc: doc('New body') }],
    ['subject', { subject: 'Second' }, { subject: 'Second' }],
    ['enabled', { enabled: false }, { enabled: false }],
    ['sendFormat', { sendFormat: 'html' }, { sendFormat: 'html' }],
    ['transactional', { transactional: false }, { transactional: false }],
    ['includeListUnsubscribeHeaders', { includeListUnsubscribeHeaders: true }, { headers: true }],
    ['fromLocal', { fromLocal: 'news' }, { sender: [domain.id, 'news', 'Riza'] }],
    ['fromName', { fromName: null }, { sender: [domain.id, 'news', null] }],
    ['fromDomainId', { fromDomainId: null }, { sender: [null, 'news', null] }],
  ]
  let expected: Record<string, unknown> = { ...full }
  for (const [field, input, delta] of change) {
    saved = await owner.action('signup.saveWelcome', { newsletterId: nl.id, revision: saved.welcome!.revision, ...input } as never)
    expected = { ...expected, ...delta }
    assert.deepEqual(state(saved), expected, field)
    // Saved again with nothing else, it stays.
    saved = await owner.action('signup.saveWelcome', { newsletterId: nl.id, revision: saved.welcome!.revision })
    assert.deepEqual(state(saved), expected, `${field} after an omitting save`)
  }
  assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).welcomeEnabled, false)
})

test('signup.saveWelcome over REST and MCP: no doc keeps the body, and the schema advertises no default', async (t) => {
  const { owner, nl, mcp, rest, tools } = await setup(t, plain)
  const created = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Hello', doc: doc('Keep me'), revision: null, sendFormat: 'plain' })
  const path = `/newsletters/${nl.id}/signup/welcome`

  const viaRest = await rest('PUT', path, { revision: created.welcome!.revision, subject: 'Via REST' })
  assert.equal(viaRest.status, 200)
  assert.deepEqual(viaRest.body.welcome.doc, doc('Keep me'))
  assert.equal(viaRest.body.welcome.subject, 'Via REST')
  assert.equal(viaRest.body.welcome.sendFormat, 'plain')
  assert.equal(viaRest.body.enabled, true)

  const viaMcp = await mcp('signup_saveWelcome', { newsletterId: nl.id, revision: viaRest.body.welcome.revision, enabled: false })
  assert.equal(viaMcp.isError, false)
  assert.deepEqual(viaMcp.out.welcome.doc, doc('Keep me'))
  assert.equal(viaMcp.out.welcome.subject, 'Via REST')
  assert.equal(viaMcp.out.enabled, false)
  const read = await owner.action('signup.get', { newsletterId: nl.id })
  assert.deepEqual(read.welcome!.doc, doc('Keep me'))
  assert.equal(read.welcomeEnabled, false)

  const schema = (await tools()).find((tool) => tool.name === 'signup_saveWelcome')!.inputSchema
  assert.deepEqual(schema.required.slice().sort(), ['newsletterId', 'revision'])
  assert.equal(JSON.stringify(schema).includes('"default"'), false, 'no default is advertised')

  // Values that are provided are still validated.
  for (const bad of [{ subject: '' }, { subject: 'x'.repeat(151) }, { enabled: 'yes' }, { doc: { type: 'paragraph' } }, { sendFormat: 'rtf' }, { transactional: 'no' }, { fromLocal: 'bad local' }]) {
    const body = { revision: viaMcp.out.welcome.revision, ...bad }
    const response = await rest('PUT', path, body)
    assert.equal(response.status, 400, JSON.stringify(bad))
    assert.equal(response.body.error.code, 'invalid_input', JSON.stringify(bad))
    assert.equal((await expectError(() => owner.action('signup.saveWelcome', { newsletterId: nl.id, ...body } as never))).code, 'invalid_input')
  }
})

test('signup.update: omitted form settings and doubleOptIn keep their value', async (t) => {
  const { owner, nl, rest } = await setup(t, plain)
  const initial = (await owner.action('signup.get', { newsletterId: nl.id })).settings
  assert.deepEqual(initial, { showName: true, fieldKeys: [], buttonLabel: 'Subscribe', successMessage: 'Thanks! Check your inbox for the next step.', redirectUrl: '', style: 'card' })
  await owner.action('signup.update', { newsletterId: nl.id, settings: { showName: false, buttonLabel: 'Join', successMessage: 'Welcome!', redirectUrl: 'https://example.com/thanks', style: 'inline' }, doubleOptIn: false })
  const full = { showName: false, fieldKeys: [], buttonLabel: 'Join', successMessage: 'Welcome!', redirectUrl: 'https://example.com/thanks', style: 'inline' }

  const one = await owner.action('signup.update', { newsletterId: nl.id, settings: { buttonLabel: 'Sign up' } })
  assert.deepEqual(one.settings, { ...full, buttonLabel: 'Sign up' })
  assert.equal(one.doubleOptIn, false, 'doubleOptIn kept')
  const flag = await rest('PUT', `/newsletters/${nl.id}/signup`, { settings: {}, doubleOptIn: true })
  assert.equal(flag.status, 200)
  assert.deepEqual(flag.body.settings, { ...full, buttonLabel: 'Sign up' })
  const read = await owner.action('signup.get', { newsletterId: nl.id })
  assert.deepEqual(read.settings, { ...full, buttonLabel: 'Sign up' })
  assert.equal(read.doubleOptIn, true)
  const none = await owner.action('signup.update', { newsletterId: nl.id, settings: {} })
  assert.equal(none.doubleOptIn, true)
  assert.equal((await rest('PUT', `/newsletters/${nl.id}/signup`, { settings: { style: 'wide' } })).status, 400)
  assert.equal((await rest('PUT', `/newsletters/${nl.id}/signup`, { settings: { buttonLabel: '' } })).body.error.code, 'invalid_input')
})

test('campaigns.updateTheme and newsletters.update: an omitted design key, header key or tracking switch keeps its value', async (t) => {
  const { owner, nl, rest } = await setup(t, plain)
  await owner.action('campaigns.updateTheme', { newsletterId: nl.id, theme: { accent: '#112233', font: 'serif', footerText: 'Bye', header: { logo: 'https://example.com/l.png', title: 'Weekly' }, headingSizes: [30, 24, 20] } })
  const full = { ...defaultTheme, accent: '#112233', font: 'serif', footerText: 'Bye', header: { logo: 'https://example.com/l.png', title: 'Weekly' }, headingSizes: [30, 24, 20] }
  assert.deepEqual((await owner.action('campaigns.getTheme', { newsletterId: nl.id })).theme, full)

  const one = await owner.action('campaigns.updateTheme', { newsletterId: nl.id, theme: { buttonShape: 'pill' } })
  assert.deepEqual(one.theme, { ...full, buttonShape: 'pill' })
  const header = await rest('PUT', `/newsletters/${nl.id}/design`, { theme: { header: { title: 'Renamed' } } })
  assert.deepEqual(header.body.theme, { ...full, buttonShape: 'pill', header: { logo: 'https://example.com/l.png', title: 'Renamed' } })
  assert.deepEqual((await owner.action('campaigns.updateTheme', { newsletterId: nl.id, theme: {} })).theme, header.body.theme)
  assert.equal((await rest('PUT', `/newsletters/${nl.id}/design`, { theme: { accent: 'red' } })).body.error.code, 'invalid_input')

  // newsletters.update takes the same partial design, and a partial tracking object.
  await owner.action('newsletters.update', { newsletterId: nl.id, theme: { background: '#000000' }, tracking: { opens: false } })
  const after = await owner.action('newsletters.get', { newsletterId: nl.id })
  assert.deepEqual(after.theme, { ...header.body.theme, background: '#000000' })
  assert.deepEqual(after.tracking, { opens: false, clicks: true })
  await owner.action('newsletters.update', { newsletterId: nl.id, tracking: { clicks: false } })
  assert.deepEqual((await owner.action('newsletters.get', { newsletterId: nl.id })).tracking, { opens: false, clicks: false })
  const preview = await owner.action('campaigns.previewDesign', { newsletterId: nl.id, theme: {} })
  assert.ok(preview.email.html.includes('#000000'), 'the preview starts from the saved design')
})

test('hygiene.updateSettings: omitted fields keep their value', async (t) => {
  const { owner, nl, rest } = await setup(t, plain)
  const defaults = await owner.action('hygiene.settings', { newsletterId: nl.id })
  await owner.action('hygiene.updateSettings', { newsletterId: nl.id, enabled: false, afterIssues: 5, waitDays: 7, strict: true, subject: 'Still here?', body: 'Click below.' })
  const full = { enabled: false, afterIssues: 5, waitDays: 7, strict: true, subject: 'Still here?', body: 'Click below.' }
  assert.deepEqual(await owner.action('hygiene.settings', { newsletterId: nl.id }), full)
  assert.deepEqual(await owner.action('hygiene.updateSettings', { newsletterId: nl.id, waitDays: 21 }), { ...full, waitDays: 21 })
  const viaRest = await rest('PUT', `/newsletters/${nl.id}/hygiene`, { subject: 'Hi again' })
  assert.deepEqual(viaRest.body, { ...full, waitDays: 21, subject: 'Hi again' })
  assert.deepEqual(await owner.action('hygiene.settings', { newsletterId: nl.id }), { ...full, waitDays: 21, subject: 'Hi again' })
  assert.equal((await rest('PUT', `/newsletters/${nl.id}/hygiene`, { afterIssues: 0 })).body.error.code, 'invalid_input')
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(full).sort())
})

test('website.update, website.publishPost and website.updateIssue: omitted fields keep their value', async (t) => {
  const { owner, nl, rest, install } = await setup(t, plain)
  await owner.action('website.update', { newsletterId: nl.id, settings: { enabled: false, seoTitle: 'Title', plausible: 'example.com', socialLinks: { x: 'https://x.com/a' }, headCode: '<meta>' } })
  const read = async () => (await owner.action('website.get', { newsletterId: nl.id })).settings
  const full = { ...(await read()) }
  assert.equal(full.enabled, false)
  assert.equal(full.seoTitle, 'Title')
  const one = await owner.action('website.update', { newsletterId: nl.id, settings: { seoDescription: 'About' } })
  assert.deepEqual(one.settings, { ...full, seoDescription: 'About' })
  const viaRest = await rest('PUT', `/newsletters/${nl.id}/website`, { settings: {} })
  assert.deepEqual(viaRest.body.settings, { ...full, seoDescription: 'About' })
  assert.deepEqual(await read(), { ...full, seoDescription: 'About' })
  assert.equal((await rest('PUT', `/newsletters/${nl.id}/website`, { settings: { ga4: 'nope' } })).body.error.code, 'invalid_input')

  // A new post gets the defaults (public, no author); a later save keeps what it omits.
  const author = await owner.action('authors.create', { newsletterId: nl.id, name: 'Riza', slug: 'riza' })
  const post = await owner.action('website.publishPost', { newsletterId: nl.id, subject: 'Post', slug: 'post', source: 'Body' })
  assert.deepEqual([post.web_visible, post.author_id], [1, null])
  const byline = await owner.action('website.publishPost', { newsletterId: nl.id, postId: post.id, authorId: author.id, visible: false })
  assert.deepEqual([byline.subject, byline.slug, byline.source, byline.web_visible, byline.author_id], ['Post', 'post', 'Body', 0, author.id])
  const retitled = await owner.action('website.publishPost', { newsletterId: nl.id, postId: post.id, subject: 'Renamed' })
  assert.deepEqual([retitled.subject, retitled.slug, retitled.source, retitled.web_visible, retitled.author_id], ['Renamed', 'post', 'Body', 0, author.id])
  const cleared = await owner.action('website.publishPost', { newsletterId: nl.id, postId: post.id, authorId: null })
  assert.equal(cleared.author_id, null)
  assert.equal((await expectError(() => owner.action('website.publishPost', { newsletterId: nl.id, subject: 'No body' }))).code, 'invalid_input')

  // A sent issue.
  const issue = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Issue', doc: doc('Hi') })
  const ctx = install.app.account(owner.accountId!).ctx
  transitionCampaign(ctx, issue.id, 'scheduled', { scheduledAt: ctx.now() + 1000 })
  transitionCampaign(ctx, issue.id, 'sending')
  transitionCampaign(ctx, issue.id, 'sent')
  const shown = await owner.action('website.updateIssue', { campaignId: issue.id, slug: 'issue-one', visible: true, authorId: author.id })
  assert.deepEqual([shown.slug, shown.visible], ['issue-one', true])
  const hidden = await owner.action('website.updateIssue', { campaignId: issue.id, visible: false })
  assert.deepEqual([hidden.slug, hidden.visible], ['issue-one', false])
  const renamed = await rest('PATCH', `/campaigns/${issue.id}/website`, { slug: 'issue-two' })
  assert.deepEqual([renamed.body.slug, renamed.body.visible], ['issue-two', false])
  const row = ctx.db.get<{ author_id: string; web_visible: number; slug: string }>('SELECT author_id, web_visible, slug FROM campaigns WHERE id = ?', issue.id)!
  assert.deepEqual([row.author_id, row.web_visible, row.slug], [author.id, 0, 'issue-two'])
  assert.equal((await rest('PATCH', `/campaigns/${issue.id}/website`, { slug: 'Not A Slug!' })).body.error.code, 'invalid_input')
})

test('authors.update and segments.update: omitted fields keep their value', async (t) => {
  const { owner, nl, rest } = await setup(t, plain)
  const author = await owner.action('authors.create', { newsletterId: nl.id, name: 'Riza', slug: 'riza', bio: 'Writes things', links: { site: 'https://example.com' } })
  const renamed = await owner.action('authors.update', { newsletterId: nl.id, authorId: author.id, name: 'Riza Q' })
  assert.deepEqual([renamed.name, renamed.slug, renamed.bio, renamed.links], ['Riza Q', 'riza', 'Writes things', { site: 'https://example.com' }])
  const viaRest = await rest('PATCH', `/newsletters/${nl.id}/authors/${author.id}`, { bio: 'New bio' })
  assert.deepEqual([viaRest.body.name, viaRest.body.slug, viaRest.body.bio, viaRest.body.links], ['Riza Q', 'riza', 'New bio', { site: 'https://example.com' }])
  assert.deepEqual((await owner.action('authors.update', { newsletterId: nl.id, authorId: author.id, links: {} })).links, {})
  assert.equal((await rest('PATCH', `/newsletters/${nl.id}/authors/${author.id}`, { slug: 'Bad Slug' })).body.error.code, 'invalid_input')
  // Creating an author still defaults the bio and links.
  const bare = await owner.action('authors.create', { newsletterId: nl.id, name: 'Bare', slug: 'bare' })
  assert.deepEqual([bare.bio, bare.links], ['', {}])

  const filter = { field: 'email', op: 'contains', value: 'example' } as never
  const segment = await owner.action('segments.create', { newsletterId: nl.id, name: 'Examples', filter })
  const same = await owner.action('segments.update', { newsletterId: nl.id, segmentId: segment.id, name: 'Renamed' })
  assert.deepEqual([same.name, same.filter], ['Renamed', segment.filter])
  const next = { field: 'email', op: 'contains', value: 'other' } as never
  const refiltered = await rest('PATCH', `/newsletters/${nl.id}/segments/${segment.id}`, { filter: next })
  assert.deepEqual([refiltered.body.name, refiltered.body.filter], ['Renamed', next])
  const list = (await owner.action('segments.list', { newsletterId: nl.id })).segments
  assert.deepEqual([list[0].name, list[0].filter], ['Renamed', next])
})

test('campaigns.update, sequences.update, sequences.updateStep and newsletters.update already keep omitted values', async (t) => {
  const { owner, nl } = await setup(t, plain)
  const issue = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Subject', doc: doc('Body'), sendFormat: 'plain', hideUnsubscribeFooter: true })
  const saved = await owner.action('campaigns.update', { campaignId: issue.id, revision: issue.revision, previewText: 'Peek' })
  assert.deepEqual([saved.subject, saved.doc, saved.sendFormat, saved.hideUnsubscribeFooter, saved.previewText, saved.format, saved.audience], ['Subject', doc('Body'), 'plain', true, 'Peek', 'doc', issue.audience])
  const again = await owner.action('campaigns.update', { campaignId: issue.id, revision: saved.revision, subject: 'Second' })
  assert.deepEqual([again.subject, again.doc, again.previewText, again.sendFormat, again.hideUnsubscribeFooter], ['Second', doc('Body'), 'Peek', 'plain', true])

  const sequence = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Drip', entry: { type: 'manual' }, steps: [{ delayDays: 1, subject: 'One', doc: doc('Step body'), sendFormat: 'plain' }] } as never)
  const step = sequence.steps[0]
  const edited = await owner.action('sequences.updateStep', { newsletterId: nl.id, sequenceId: sequence.id, stepId: step.id, revision: step.revision, previewText: 'Peek' })
  assert.deepEqual([edited.subject, edited.doc, edited.sendFormat, edited.delayDays, edited.previewText], ['One', doc('Step body'), 'plain', 1, 'Peek'])
  const renamed = await owner.action('sequences.update', { newsletterId: nl.id, sequenceId: sequence.id, name: 'Drip 2' })
  assert.deepEqual([renamed.name, renamed.entry], ['Drip 2', sequence.entry])

  const before = await owner.action('newsletters.get', { newsletterId: nl.id })
  await owner.action('newsletters.update', { newsletterId: nl.id, description: 'About' })
  const after = await owner.action('newsletters.get', { newsletterId: nl.id })
  assert.deepEqual({ ...after, description: before.description }, before)
  assert.equal(after.description, 'About')
})

test('MCP and OpenAPI advertise no default on an update input', async (t) => {
  const { tools, install, headers } = await setup(t, plain)
  const updates = ['signup_saveWelcome', 'signup_update', 'campaigns_update', 'campaigns_updateTheme', 'newsletters_update', 'sequences_update', 'sequences_updateStep', 'hygiene_updateSettings', 'website_update', 'website_updateIssue', 'website_publishPost', 'authors_update', 'segments_update', 'contacts_update']
  const list = await tools()
  for (const name of updates) {
    const schema = list.find((tool) => tool.name === name)?.inputSchema
    assert.ok(schema, name)
    assert.equal(JSON.stringify(schema).includes('"default"'), false, `${name} advertises a default`)
  }
  const spec = await (await install.fetch('/api/v1/openapi.json', { headers })).json()
  {
    const methods = Object.entries<Record<string, any>>(spec.paths).flatMap(([path, ops]) => Object.entries(ops).filter(([method]) => ['put', 'patch'].includes(method)).map(([method, op]) => ({ at: `${method} ${path}`, op })))
    assert.ok(methods.length > 0)
    for (const { at, op } of methods) assert.equal(JSON.stringify(op.requestBody ?? {}).includes('"default"'), false, `${at} advertises a default`)
  }
})
