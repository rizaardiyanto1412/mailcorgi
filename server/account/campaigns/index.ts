import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { notFound } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { emptyDoc, parseTheme, themeSchema, renderEmail, renderWeb } from '../render/index.ts'
import { assertEditable, assertRevision, audienceSchema, draftFields, getCampaign, getCampaignRow, serializeCampaign, statusSchema, type CampaignAudience, type CampaignRow } from './model.ts'
import { reviewChecks } from './review.ts'
import { uploadImageAction } from './uploads.ts'
export { getCampaign, getCampaignRow, serializeCampaign, transitionCampaign, statusSchema, audienceSchema } from './model.ts'
export type { Campaign, CampaignRow, CampaignStatus, CampaignAudience } from './model.ts'
export { reviewChecks } from './review.ts'
export type { ReviewCheck } from './review.ts'

const newsletterId = z.string().min(1).describe('The newsletter id')
const campaignId = z.string().min(1).describe('The campaign id')
const revision = z.number().int().min(1).describe('The revision last read. Stale saves return 409 with the current revision.')
const campaignResource = { type: 'campaign', param: 'campaignId' } as const
const newsletterResource = { type: 'newsletter', param: 'newsletterId' } as const
function newsletter(ctx: StoreCtx, id: string) {
  const row = getNewsletterRow(ctx, id)
  if (!row) throw notFound('That newsletter')
  return row
}
function validateAudience(ctx: StoreCtx, newsletterId: string, audience: CampaignAudience) {
  const tags = [...audience.tagIds ?? [], ...audience.exclude?.tagIds ?? []]
  const segments = [...audience.segmentId ? [audience.segmentId] : [], ...audience.exclude?.segmentIds ?? []]
  for (const id of tags) if (!ctx.db.get('SELECT id FROM tags WHERE id = ? AND newsletter_id = ?', id, newsletterId)) throw notFound('That audience tag')
  for (const id of segments) if (!ctx.db.get('SELECT id FROM segments WHERE id = ? AND newsletter_id = ?', id, newsletterId)) throw notFound('That audience segment')
}
function previews(ctx: StoreCtx, row: CampaignRow) {
  const nl = newsletter(ctx, row.newsletter_id)
  const theme = parseTheme(nl.theme)
  const campaign = serializeCampaign(row)
  const base = ctx.config.appUrl
  return {
    campaign, theme,
    email: renderEmail({ campaign, newsletter: { ...nl }, theme, recipient: { contact: { name: 'Reader', email: 'reader@example.com' }, links: { unsubscribe: `${base}/unsubscribe-preview`, preferences: `${base}/preferences-preview`, web: `${base}/n/${nl.slug}/${row.slug || row.id}` } } }),
    web: renderWeb({ campaign, newsletter: { ...nl }, theme }),
    checks: reviewChecks({ campaign, newsletter: { ...nl }, theme, domainVerified: !!(nl.domain_id && ctx.db.get('SELECT id FROM domains WHERE id = ? AND status = ?', nl.domain_id, 'verified')) }),
  }
}
export const campaignsModule = {
  name: 'campaigns',
  register(reg: AccountRegistrar) {
    reg.resolver('campaign', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM campaigns WHERE id = ?', id)?.newsletter_id ?? null)
    return reg.actions(
      defineAction({
        name: 'campaigns.list', description: 'List campaigns by status and subject.', scope: 'account', role: 'member', effect: 'read', resource: newsletterResource,
        input: z.object({ newsletterId, status: statusSchema.optional().describe('Filter by campaign status'), search: z.string().max(200).optional().describe('Search the subject'), limit: z.number().int().min(1).max(100).default(30).describe('Maximum rows'), offset: z.number().int().min(0).default(0).describe('Number of rows to skip') }),
        rest: { method: 'GET', path: '/newsletters/:newsletterId/campaigns' }, mcp: { title: 'List campaigns', destructive: false },
        handler: (ctx, input) => {
          const where = "newsletter_id = ? AND kind = 'issue' AND (? IS NULL OR status = ?) AND instr(lower(subject), lower(?)) > 0"
          const params = [input.newsletterId, input.status ?? null, input.status ?? null, input.search ?? '']
          const rows = ctx.db.all<CampaignRow>(`SELECT * FROM campaigns WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, input.limit, input.offset)
          return { campaigns: rows.map((r) => ({ id: r.id, newsletterId: r.newsletter_id, subject: r.subject, status: r.status, format: r.format, updatedAt: r.updated_at, revision: r.revision })), total: ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM campaigns WHERE ${where}`, ...params)!.n }
        },
      }),
      defineAction({
        name: 'campaigns.create', description: 'Create a campaign draft.', scope: 'account', role: 'member', effect: 'write', resource: newsletterResource,
        input: z.object({ newsletterId, subject: draftFields.subject.default('').describe('Email subject or draft name'), format: draftFields.format.default('doc').describe('Content format'), doc: draftFields.doc.optional().describe('Initial TipTap document'), source: draftFields.source.optional().describe('Markdown or HTML source'), html: draftFields.html.optional().describe('Raw email HTML'), text: draftFields.text.optional().describe('Plain text alternative'), audience: audienceSchema.default({ all: true }).describe('Audience selection and exclusions') }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/campaigns' }, mcp: { title: 'Create a campaign draft', destructive: false },
        handler: (ctx, input, actor) => {
          validateAudience(ctx, input.newsletterId, input.audience)
          const id = newId('cmp')
          ctx.db.run('INSERT INTO campaigns (id, newsletter_id, subject, format, doc, source, html, text, audience, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, input.newsletterId, input.subject, input.format, JSON.stringify(input.doc ?? emptyDoc), input.source ?? '', input.html ?? '', input.text ?? '', JSON.stringify(input.audience), actor.userId, ctx.now(), ctx.now())
          return getCampaign(ctx, id)
        },
      }),
      defineAction({
        name: 'campaigns.get', description: 'Read a campaign and its current revision.', scope: 'account', role: 'member', effect: 'read', resource: campaignResource,
        input: z.object({ campaignId }), rest: { method: 'GET', path: '/campaigns/:campaignId' }, mcp: { title: 'Get a campaign', destructive: false },
        handler: (ctx, input) => getCampaign(ctx, input.campaignId),
      }),
      defineAction({
        name: 'campaigns.update', description: 'Autosave a draft only if its revision is still current.', scope: 'account', role: 'member', effect: 'write', resource: campaignResource,
        input: z.object({
          campaignId, revision,
          subject: draftFields.subject.optional().describe('Email subject or draft name'), previewText: draftFields.previewText.optional().describe('Inbox preview text'),
          format: draftFields.format.optional().describe('Content format'), doc: draftFields.doc.optional().describe('TipTap document JSON'), source: draftFields.source.optional().describe('Markdown or HTML source'),
          html: draftFields.html.optional().describe('Raw email HTML'), text: draftFields.text.optional().describe('Plain text alternative'), audience: audienceSchema.optional().describe('Audience selection and exclusions'),
        }),
        rest: { method: 'PATCH', path: '/campaigns/:campaignId' }, mcp: { title: 'Save a campaign draft', destructive: false },
        handler: (ctx, input) => ctx.db.tx(() => {
          const row = getCampaignRow(ctx, input.campaignId)
          assertEditable(row)
          assertRevision(row, input.revision)
          if (input.audience) validateAudience(ctx, row.newsletter_id, input.audience)
          ctx.db.run('UPDATE campaigns SET subject = ?, preview_text = ?, format = ?, doc = ?, source = ?, html = ?, text = ?, audience = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND newsletter_id = ? AND revision = ?',
            input.subject ?? row.subject, input.previewText ?? row.preview_text, input.format ?? row.format, input.doc ? JSON.stringify(input.doc) : row.doc, input.source ?? row.source, input.html ?? row.html, input.text ?? row.text, input.audience ? JSON.stringify(input.audience) : row.audience, ctx.now(), row.id, row.newsletter_id, input.revision)
          return getCampaign(ctx, row.id)
        }),
      }),
      defineAction({
        name: 'campaigns.duplicate', description: 'Copy a campaign into a new editable draft.', scope: 'account', role: 'member', effect: 'write', resource: campaignResource,
        input: z.object({ campaignId }), rest: { method: 'POST', path: '/campaigns/:campaignId/duplicate' }, mcp: { title: 'Duplicate a campaign', destructive: false },
        handler: (ctx, input, actor) => {
          const row = getCampaignRow(ctx, input.campaignId)
          const id = newId('cmp')
          ctx.db.run('INSERT INTO campaigns (id, newsletter_id, author_id, kind, subject, preview_text, format, doc, source, html, text, audience, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, row.newsletter_id, row.author_id, row.kind, `${row.subject} (copy)`, row.preview_text, row.format, row.doc, row.source, row.html, row.text, row.audience, actor.userId, ctx.now(), ctx.now())
          return getCampaign(ctx, id)
        },
      }),
      defineAction({
        name: 'campaigns.delete', description: 'Permanently delete an editable draft.', scope: 'account', role: 'member', effect: 'write', resource: campaignResource,
        input: z.object({ campaignId, revision }), rest: { method: 'DELETE', path: '/campaigns/:campaignId' }, mcp: { title: 'Delete a campaign draft', destructive: true },
        handler: (ctx, input) => ctx.db.tx(() => {
          const row = getCampaignRow(ctx, input.campaignId)
          assertEditable(row)
          assertRevision(row, input.revision)
          ctx.db.run('DELETE FROM campaigns WHERE id = ? AND newsletter_id = ?', row.id, row.newsletter_id)
          return { deleted: true }
        }),
      }),
      defineAction({
        name: 'campaigns.preview', description: 'Render email and web previews with review checks.', scope: 'account', role: 'member', effect: 'read', resource: campaignResource,
        input: z.object({ campaignId }), rest: { method: 'GET', path: '/campaigns/:campaignId/preview' }, mcp: { title: 'Preview a campaign', destructive: false },
        handler: (ctx, input) => previews(ctx, getCampaignRow(ctx, input.campaignId)),
      }),
      defineAction({
        name: 'campaigns.audienceOptions', description: 'List saved segments and tags for the audience picker.', scope: 'account', role: 'member', effect: 'read', resource: newsletterResource,
        input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/campaign-audiences' }, mcp: { title: 'List campaign audiences', destructive: false },
        handler: (ctx, input) => ({
          tags: ctx.db.all<{
            id: string
            name: string
          }>('SELECT id, name FROM tags WHERE newsletter_id = ? ORDER BY name', input.newsletterId), segments: ctx.db.all<{
            id: string
            name: string
          }>('SELECT id, name FROM segments WHERE newsletter_id = ? ORDER BY name', input.newsletterId)
        }),
      }),
      defineAction({
        name: 'campaigns.getTheme', description: 'Read the newsletter email and web design.', scope: 'account', role: 'member', effect: 'read', resource: newsletterResource,
        input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/design' }, mcp: { title: 'Read newsletter design', destructive: false },
        handler: (ctx, input) => ({ theme: parseTheme(newsletter(ctx, input.newsletterId).theme) }),
      }),
      defineAction({
        name: 'campaigns.updateTheme', description: 'Save the newsletter email and web design.', scope: 'account', role: 'admin', effect: 'write', resource: newsletterResource,
        input: z.object({ newsletterId, theme: themeSchema.describe('Colors, email-safe fonts, heading sizes, button style, header and footer') }),
        rest: { method: 'PUT', path: '/newsletters/:newsletterId/design' }, mcp: { title: 'Save newsletter design', destructive: false },
        handler: (ctx, input) => {
          ctx.db.run('UPDATE newsletters SET theme = ?, updated_at = ? WHERE id = ?', JSON.stringify(input.theme), ctx.now(), input.newsletterId)
          return { theme: input.theme }
        },
      }),
      defineAction({
        name: 'campaigns.previewDesign', description: 'Preview an unsaved newsletter design with sample content.', scope: 'account', role: 'member', effect: 'read', resource: newsletterResource,
        input: z.object({ newsletterId, theme: themeSchema.describe('Design to preview without saving') }),
        handler: (ctx, input) => {
          const nl = newsletter(ctx, input.newsletterId)
          const campaign = { subject: 'A little inspiration for your week', previewText: 'Your next great issue starts here.', format: 'doc', doc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hello, {{first_name|reader}}' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'A thoughtful story, a useful idea, and something worth sharing. This is your newsletter, in your own style.' }] }, { type: 'button', attrs: { label: 'Keep reading', href: 'https://example.com', align: 'left' } }] } }
          return { email: renderEmail({ campaign, newsletter: { ...nl }, theme: input.theme, recipient: { contact: { name: 'Reader' }, links: { unsubscribe: 'https://example.com/unsubscribe', preferences: 'https://example.com/preferences', web: 'https://example.com/issue' } } }), web: renderWeb({ campaign, newsletter: { ...nl }, theme: input.theme }) }
        },
      }),
      uploadImageAction,
    )
  },
}
