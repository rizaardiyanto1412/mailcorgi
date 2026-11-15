import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import { Node } from '@tiptap/pm/model'
import { campaignExtensions } from '../../web/src/features/campaigns/extensions.ts'
import { createInstall, expectError } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import { transitionCampaign } from '../account/campaigns/index.ts'
import { themePresets } from '../account/render/index.ts'

for (const cloud of [false, true]) test(`campaign draft lifecycle and revision conflicts (${cloud ? 'cloud' : 'self-hosted'})`, async () => {
  const install = await createInstall({ cloud })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const initial = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'First issue' })
    assert.equal(initial.status, 'draft')
    assert.equal(initial.revision, 1)
    assert.deepEqual(initial.audience, { all: true })
    const schema = getSchema(campaignExtensions())
    const editorDoc = Node.fromJSON(schema, { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'News' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello {{first_name|reader}}', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }] }] },
      { type: 'callout', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A useful note' }] }] },
      { type: 'button', attrs: { label: 'Read', href: 'https://example.com' } },
      { type: 'image', attrs: { src: 'https://example.com/image.png', alt: 'A corgi', width: 300, height: 200, caption: 'A garden' } },
      { type: 'divider' }, { type: 'spacer' }, { type: 'embed', attrs: { url: 'https://example.com', title: 'A link', description: 'A useful link' } },
    ] }).toJSON()
    const savedResponse = await owner.actionRaw('campaigns.update', { campaignId: initial.id, revision: 1, subject: 'Renamed issue', previewText: 'This week', doc: editorDoc, audience: { engaged: true } })
    assert.equal(savedResponse.status, 200)
    const saved = await owner.action('campaigns.get', { campaignId: initial.id })
    assert.deepEqual(saved.doc, JSON.parse(JSON.stringify(editorDoc)))
    assert.equal(saved.revision, 2)
    const stale = await expectError(() => owner.action('campaigns.update', { campaignId: initial.id, revision: 1, subject: 'Overwrite' }))
    assert.equal(stale.status, 409)
    assert.deepEqual(stale.details, { revision: 2 })
    assert.equal((await owner.action('campaigns.get', { campaignId: initial.id })).subject, 'Renamed issue')
    const filtered = await owner.action('campaigns.list', { newsletterId: nl.id, status: 'draft', search: 'renamed' })
    assert.equal(filtered.total, 1)
    assert.equal(filtered.campaigns[0].id, initial.id)
    assert.equal((await owner.action('campaigns.list', { newsletterId: nl.id, search: '%_injection' })).total, 0)
    const copy = await owner.action('campaigns.duplicate', { campaignId: initial.id })
    assert.notEqual(copy.id, initial.id)
    assert.equal(copy.status, 'draft')
    assert.equal(copy.revision, 1)
    assert.deepEqual(copy.doc, saved.doc)
    assert.deepEqual(copy.audience, { engaged: true })
    const preview = await owner.action('campaigns.preview', { campaignId: initial.id })
    assert.match(preview.email.html, /Hello Reader/)
    assert.match(preview.web.html, /Renamed issue/)
    assert.ok(preview.checks.some((c) => c.id === 'postal_address'))
    await owner.action('campaigns.delete', { campaignId: copy.id, revision: 1 })
    assert.equal((await expectError(() => owner.action('campaigns.get', { campaignId: copy.id }))).status, 404)
    assert.equal((await owner.action('campaigns.list', { newsletterId: nl.id, limit: 1 })).campaigns.length, 1)
  } finally { install.close() }
})
test('permissions isolate newsletters, accounts and read-only actors; members can write drafts but cannot change design', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const hidden = await owner.action('newsletters.create', { name: 'Private' })
    const draft = await owner.action('campaigns.create', { newsletterId: nl.id })
    const hiddenDraft = await owner.action('campaigns.create', { newsletterId: hidden.id })
    const ctx = install.app.account(owner.accountId!).ctx
    const actor: Actor = { userId: 'usr_member', email: 'member@example.com', owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
    await runAction(ctx, 'campaigns.update', { campaignId: draft.id, revision: 1, subject: 'Member edit' }, actor)
    assert.equal((await owner.action('campaigns.get', { campaignId: draft.id })).subject, 'Member edit')
    for (const [name, input] of [
      ['campaigns.get', { campaignId: hiddenDraft.id }], ['campaigns.update', { campaignId: hiddenDraft.id, revision: 1, subject: 'Bad' }],
      ['campaigns.list', { newsletterId: hidden.id }], ['campaigns.updateTheme', { newsletterId: nl.id, theme: {} }],
    ] satisfies [string, unknown][]) await assert.rejects(() => runAction(ctx, name, input, actor), (e: unknown) => e instanceof AppError && e.status === 403)
    await assert.rejects(() => runAction(ctx, 'campaigns.update', { campaignId: draft.id, revision: 2 }, { ...actor, access: 'read' }), (e: unknown) => e instanceof AppError && e.status === 403)
    const other = await install.signUp({ email: 'other@example.com' })
    for (const name of ['campaigns.get', 'campaigns.preview', 'campaigns.duplicate']) assert.equal((await expectError(() => other.actionRaw(name, { campaignId: draft.id }).then(async (r) => {
      if (!r.ok) { const data = await r.json(); const { ActionError } = await import('./harness.ts'); throw new ActionError(r.status, data.code, data.error) }
    }))).status, 404)
  } finally { install.close() }
})
test('only transitionCampaign writes status; non-drafts reject editing and deleting and copies reset state', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Issue' })
    const ctx = install.app.account(owner.accountId!).ctx
    assert.throws(() => transitionCampaign(ctx, draft.id, 'sent'), /Cannot move/)
    assert.throws(() => transitionCampaign(ctx, draft.id, 'scheduled'), /future/)
    const schedule = transitionCampaign(ctx, draft.id, 'scheduled', { scheduledAt: ctx.now() + 60000 })
    assert.equal(schedule.revision, 2)
    assert.equal(transitionCampaign(ctx, draft.id, 'scheduled').revision, 2)
    assert.equal((await expectError(() => owner.action('campaigns.update', { campaignId: draft.id, revision: 2, subject: 'Change' }))).code, 'not_editable')
    assert.equal((await expectError(() => owner.action('campaigns.delete', { campaignId: draft.id, revision: 2 }))).status, 409)
    transitionCampaign(ctx, draft.id, 'sending')
    const paused = transitionCampaign(ctx, draft.id, 'paused', { reason: 'High bounces' })
    assert.equal(paused.pauseReason, 'High bounces')
    transitionCampaign(ctx, draft.id, 'sending')
    const sent = transitionCampaign(ctx, draft.id, 'sent')
    assert.equal(sent.sentAt, ctx.now())
    assert.equal(sent.pauseReason, null)
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE campaign_id = ?', draft.id)!.n, 5)
    assert.ok(ctx.db.get('SELECT newsletter_id FROM daily_stats WHERE newsletter_id = ?', nl.id))
    const copy = await owner.action('campaigns.duplicate', { campaignId: draft.id })
    assert.equal(copy.status, 'draft'); assert.equal(copy.scheduledAt, null); assert.equal(copy.sentAt, null)
  } finally { install.close() }
})
test('audience references stay in their newsletter, with exclusions preserved', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const other = await owner.action('newsletters.create', { name: 'Another' })
    const db = install.app.account(owner.accountId!).ctx.db
    for (const [id, newsletterId] of [['tag_a', nl.id], ['tag_b', nl.id], ['tag_other', other.id]]) db.run('INSERT INTO tags (id, newsletter_id, name) VALUES (?, ?, ?)', id, newsletterId, id)
    db.run('INSERT INTO segments (id, newsletter_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'seg_a', nl.id, 'Readers', 1, 1)
    const options = await owner.action('campaigns.audienceOptions', { newsletterId: nl.id })
    assert.equal(options.tags.length, 2); assert.equal(options.segments.length, 1)
    const draft = await owner.action('campaigns.create', { newsletterId: nl.id, audience: { tagIds: ['tag_a'], exclude: { tagIds: ['tag_b'], segmentIds: ['seg_a'] } } })
    assert.deepEqual(draft.audience, { tagIds: ['tag_a'], exclude: { tagIds: ['tag_b'], segmentIds: ['seg_a'] } })
    assert.equal((await expectError(() => owner.action('campaigns.update', { campaignId: draft.id, revision: 1, audience: { tagIds: ['tag_other'] } }))).status, 404)
    assert.equal((await expectError(() => owner.action('campaigns.create', { newsletterId: nl.id, audience: { all: true, engaged: true } }))).code, 'invalid_input')
    assert.equal((await owner.action('campaigns.get', { campaignId: draft.id })).revision, 1)
  } finally { install.close() }
})
test('theme edits persist, reject CSS injection and generate sample previews without saving', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const theme = themePresets[1].theme
    await owner.action('campaigns.updateTheme', { newsletterId: nl.id, theme })
    assert.deepEqual((await owner.action('campaigns.getTheme', { newsletterId: nl.id })).theme, theme)
    const preview = await owner.action('campaigns.previewDesign', { newsletterId: nl.id, theme: themePresets[2].theme })
    assert.match(preview.email.html, /A thoughtful story/)
    assert.match(preview.web.html, /A thoughtful story/)
    assert.deepEqual((await owner.action('campaigns.getTheme', { newsletterId: nl.id })).theme, theme)
    assert.equal((await expectError(() => owner.action('campaigns.updateTheme', { newsletterId: nl.id, theme: { ...theme, accent: '#fff;position:fixed' } }))).code, 'invalid_input')
  } finally { install.close() }
})
test('image uploads inspect magic bytes, cap size, record metadata and serve the public URL', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'
    const image = await owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: png, width: 1, height: 1 })
    assert.match(image.key, new RegExp(`^${nl.id}/[a-z2-7]+\\.png$`))
    assert.equal(image.contentType, 'image/png')
    const response = await install.fetch(new URL(image.url).pathname)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(new Uint8Array(await response.arrayBuffer())[0], 137)
    const ctx = install.app.account(owner.accountId!).ctx
    assert.equal(ctx.db.get<{ width: number }>('SELECT width FROM uploads WHERE key = ?', image.key)?.width, 1)
    const bad = await expectError(() => owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: btoa('<svg onload="alert(1)"></svg>'), width: 1, height: 1 }))
    assert.equal(bad.code, 'image_type')
    assert.equal((await expectError(() => owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: '!', width: 1, height: 1 }))).code, 'invalid_image')
    const big = await expectError(() => owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: 'A'.repeat(Math.ceil(5 * 1024 * 1024 / 3) * 4 + 4), width: 1, height: 1 }))
    assert.equal(big.status, 400)
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM uploads')!.n, 1)
  } finally { install.close() }
})
