import { z } from 'zod'
import { defineAction, meetsRole } from '../../core/actions.ts'
import { AppError, forbidden, notFound } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import { withPatch } from '../../core/patch.ts'
import { getCampaignRow } from '../campaigns/index.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { migrations } from './migrations.ts'
import { registerRoutes } from './routes.ts'
import { hostActions, hostInfo, registerHostJobs } from './hosts.ts'
import { assertSlugFree, ensureAppUrl, newsletter, settings, settingsSchema, slugSchema, type WebPost } from './model.ts'
export { baseUrl as websiteUrl, websiteHost } from './model.ts'

const newsletterId = z.string().min(1).describe('The newsletter id')
const resource = { type: 'newsletter', param: 'newsletterId' } as const
export const websiteModule = {
  name: 'website',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    registerHostJobs(reg)
    registerRoutes(reg)
    return reg.actions(
      ...hostActions,
      defineAction({ name: 'website.get', description: 'Read public website settings, custom hostname records and web-only posts.', scope: 'account', role: 'admin', effect: 'read', resource, input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/website' }, mcp: { title: 'Read website settings', destructive: false }, handler: async (ctx, input) => { await ensureAppUrl(ctx); return { settings: settings(newsletter(ctx, input.newsletterId).website), host: hostInfo(ctx, input.newsletterId), posts: ctx.db.all<WebPost>('SELECT * FROM website_posts WHERE newsletter_id = ? ORDER BY published_at DESC', input.newsletterId) } } }),
      defineAction({ name: 'website.update', description: 'Save website SEO, analytics ids, social links and custom code.', scope: 'account', role: 'admin', effect: 'write', resource, input: z.object({ newsletterId, settings: settingsSchema.describe('Public website options. Omitted keys keep their saved value.') }), rest: { method: 'PUT', path: '/newsletters/:newsletterId/website' }, mcp: { title: 'Save website settings', destructive: false }, handler: (ctx, input) => {
        const next = withPatch(settings(newsletter(ctx, input.newsletterId).website), input.settings)
        ctx.db.run('UPDATE newsletters SET website = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), ctx.now(), input.newsletterId)
        return { settings: next }
      } }),
      defineAction({ name: 'website.updateIssue', description: 'Show or hide a sent issue and change its public slug and author without editing its email.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'campaign', param: 'campaignId' }, input: z.object({ campaignId: z.string().min(1).describe('The sent campaign id'), slug: slugSchema.optional().describe('Public issue address. Omit to keep the current one.'), visible: z.boolean().optional().describe('Whether to list and serve the issue publicly. Omit to keep the current value.'), authorId: z.string().nullable().optional().describe('Newsletter author id, or null for no byline') }), rest: { method: 'PATCH', path: '/campaigns/:campaignId/website' }, mcp: { title: 'Edit issue publishing', destructive: false }, handler: (ctx, input) => {
        const row = getCampaignRow(ctx, input.campaignId)
        if (row.status !== 'sent' || row.kind !== 'issue') throw new AppError('not_sent', 'Only sent issues can appear in the archive.', 409)
        const slug = input.slug ?? row.slug
        const visible = input.visible ?? !!row.web_visible
        if (input.slug !== undefined) assertSlugFree(ctx, row.newsletter_id, input.slug, row.id)
        if (input.authorId && !ctx.db.get('SELECT id FROM authors WHERE id = ? AND newsletter_id = ?', input.authorId, row.newsletter_id)) throw notFound('That author')
        ctx.db.run('UPDATE campaigns SET slug = ?, web_visible = ?, author_id = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?', slug, visible ? 1 : 0, input.authorId === undefined ? row.author_id : input.authorId, ctx.now(), row.id, row.newsletter_id)
        return { id: row.id, slug, visible }
      } }),
      defineAction({ name: 'website.publishPost', description: 'Draft, publish or update a web-only Markdown post without sending an email.', scope: 'account', role: 'member', effect: 'write', resource, input: z.object({ newsletterId, postId: z.string().optional().describe('An existing web-only post id to update'), subject: z.string().trim().min(1).max(500).optional().describe('Post title. Required for a new post; omit to keep the current one.'), slug: slugSchema.optional().describe('Public post address. Required for a new post; omit to keep the current one.'), source: z.string().max(1_000_000).optional().describe('Markdown content. Required for a new post; omit to keep the current one.'), authorId: z.string().nullable().optional().describe('Newsletter author id, or null for no byline. Omit to keep the current author; a new post has none.'), visible: z.boolean().optional().describe('Whether the post is public. Omit to keep the current value; a new post is public.') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/website/posts' }, mcp: { title: 'Publish a web-only post', destructive: false }, handler: (ctx, input, actor) => {
        if (input.authorId && !ctx.db.get('SELECT id FROM authors WHERE id = ? AND newsletter_id = ?', input.authorId, input.newsletterId)) throw notFound('That author')
        const existing = input.postId ? ctx.db.get<WebPost>('SELECT * FROM website_posts WHERE id = ? AND newsletter_id = ?', input.postId, input.newsletterId) : undefined
        if (input.postId && !existing) throw notFound('That post')
        // An omitted field keeps the stored value; the defaults (no author, public) apply only to a new post.
        const subject = input.subject ?? existing?.subject
        const slug = input.slug ?? existing?.slug
        const source = input.source ?? existing?.source
        if (subject === undefined || slug === undefined || source === undefined) throw new AppError('invalid_input', 'A new post needs a subject, slug and source.', 400)
        const authorId = input.authorId === undefined ? existing?.author_id ?? null : input.authorId
        const visible = input.visible ?? (existing ? !!existing.web_visible : true)
        if ((visible || existing?.web_visible) && !meetsRole(actor, input.newsletterId, 'admin')) throw forbidden('Only newsletter admins can publish, edit or hide public posts.')
        const id = existing?.id ?? newId('post')
        assertSlugFree(ctx, input.newsletterId, slug, id)
        ctx.db.run('INSERT INTO website_posts (id, newsletter_id, author_id, subject, slug, source, published_at, web_visible, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET author_id = excluded.author_id, subject = excluded.subject, slug = excluded.slug, source = excluded.source, web_visible = excluded.web_visible, updated_at = excluded.updated_at', id, input.newsletterId, authorId, subject, slug, source, existing?.published_at ?? ctx.now(), visible ? 1 : 0, ctx.now())
        return ctx.db.get<WebPost>('SELECT * FROM website_posts WHERE id = ? AND newsletter_id = ?', id, input.newsletterId)!
      } }),
      defineAction({ name: 'website.stats', description: 'Read recent cookie-free public page views.', scope: 'account', role: 'admin', effect: 'read', resource, input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/website/stats' }, mcp: { title: 'Read website traffic', destructive: false }, handler: (ctx, input) => ({ days: ctx.db.all<{ day: string; page_views: number }>('SELECT day, page_views FROM daily_stats WHERE newsletter_id = ? ORDER BY day DESC LIMIT 30', input.newsletterId), referrers: ctx.db.all<{ host: string; views: number }>('SELECT referrer_host AS host, COUNT(*) AS views FROM page_views WHERE newsletter_id = ? AND at >= ? GROUP BY referrer_host ORDER BY views DESC LIMIT 20', input.newsletterId, ctx.now() - 30 * 86400000) }) }),
    )
  },
}
