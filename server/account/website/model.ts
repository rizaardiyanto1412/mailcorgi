import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { AppError, notFound } from '../../core/http.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import type { CampaignRow } from '../campaigns/index.ts'

const webUrl = z.url().refine((v) => /^https?:\/\//.test(v), 'Use an http or https URL.')
export const settingsSchema = z.object({
  enabled: z.boolean().default(true).describe('Make the public archive discoverable'),
  seoTitle: z.string().max(160).default('').describe('Optional home page title'),
  seoDescription: z.string().max(500).default('').describe('Optional search engine description'),
  plausible: z.string().max(253).regex(/^[a-zA-Z0-9.-]*$/).default('').describe('Plausible site domain'),
  ga4: z.string().regex(/^(G-[A-Z0-9]+)?$/).default('').describe('Google Analytics measurement id'),
  fathom: z.string().regex(/^[A-Z0-9]*$/).max(30).default('').describe('Fathom site id'),
  umami: z.string().regex(/^[a-fA-F0-9-]*$/).max(50).default('').describe('Umami Cloud website id'),
  headCode: z.string().max(20000).default('').describe('Custom head HTML, used only on a verified custom host'),
  bodyCode: z.string().max(20000).default('').describe('Custom body HTML, used only on a verified custom host'),
  socialLinks: z.record(z.string().max(50), webUrl).default({}).describe('Named public social links'),
  favicon: webUrl.or(z.literal('')).default('').describe('Optional favicon URL; otherwise the newsletter icon is used'),
})
export type WebsiteSettings = z.infer<typeof settingsSchema>
export function settings(value: string): WebsiteSettings {
  return settingsSchema.parse(JSON.parse(value))
}
export const slugSchema = z.string().trim().toLowerCase().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine((v) => !['feed', 'feed-xml', 'sitemap', 'robots', 'authors', 'author', 'page'].includes(v), 'That address is reserved.')
export const hostnameSchema = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a hostname without a scheme, port or path.')
export interface HostRow { newsletter_id: string; hostname: string; token: string; verified_at: number | null; cf_id: string | null }
export const websiteHost = (ctx: StoreCtx, newsletterId: string) => ctx.db.get<HostRow>('SELECT * FROM website_hosts WHERE newsletter_id = ?', newsletterId)
export function newsletter(ctx: StoreCtx, newsletterId: string) {
  const row = getNewsletterRow(ctx, newsletterId)
  if (!row) throw notFound('That newsletter')
  return row
}
export function baseUrl(ctx: StoreCtx, newsletterId: string, origin = ctx.config.appUrl) {
  const nl = newsletter(ctx, newsletterId)
  const host = websiteHost(ctx, newsletterId)
  return host?.verified_at !== null && host?.verified_at !== undefined ? `https://${host.hostname}` : `${origin}/n/${nl.slug}`
}
export interface WebPost { id: string; newsletter_id: string; author_id: string | null; subject: string; slug: string; source: string; published_at: number; web_visible: number; updated_at: number }
export type PublicIssue = { kind: 'campaign'; row: CampaignRow } | { kind: 'post'; row: WebPost }
export const publishedWhere = "kind = 'issue' AND status = 'sent' AND web_visible = 1"
export function publicIssues(ctx: StoreCtx, newsletterId: string): PublicIssue[] {
  const campaigns = ctx.db.all<CampaignRow>(`SELECT * FROM campaigns WHERE newsletter_id = ? AND ${publishedWhere}`, newsletterId).map((row): PublicIssue => ({ kind: 'campaign', row }))
  const posts = ctx.db.all<WebPost>('SELECT * FROM website_posts WHERE newsletter_id = ? AND web_visible = 1', newsletterId).map((row): PublicIssue => ({ kind: 'post', row }))
  return [...campaigns, ...posts].sort((a, b) => issueDate(b) - issueDate(a) || b.row.id.localeCompare(a.row.id))
}
/** Public issue count from indexes, for paging checks without loading every issue. */
export function countPublicIssues(ctx: StoreCtx, newsletterId: string, authorId?: string): number {
  const filter = authorId ? ' AND author_id = ?' : ''
  const args = authorId ? [newsletterId, authorId] : [newsletterId]
  return ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM campaigns WHERE newsletter_id = ? AND ${publishedWhere}${filter}`, ...args)!.n
    + ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM website_posts WHERE newsletter_id = ? AND web_visible = 1${filter}`, ...args)!.n
}
/** Whether `/<slug>` names a public issue, by the slug index (or the id when an issue has no slug). */
export function hasPublicIssue(ctx: StoreCtx, newsletterId: string, slug: string): boolean {
  return !!ctx.db.get(`SELECT 1 FROM campaigns WHERE newsletter_id = ? AND slug != '' AND slug = ? AND ${publishedWhere}`, newsletterId, slug)
    || !!ctx.db.get(`SELECT 1 FROM campaigns WHERE id = ? AND newsletter_id = ? AND COALESCE(slug, '') = '' AND ${publishedWhere}`, slug, newsletterId)
    || !!ctx.db.get('SELECT 1 FROM website_posts WHERE newsletter_id = ? AND slug = ? AND web_visible = 1', newsletterId, slug)
}
export const issueSlug = (issue: PublicIssue) => issue.row.slug || issue.row.id
export const issueDate = (issue: PublicIssue) => issue.kind === 'campaign' ? issue.row.published_at ?? issue.row.sent_at ?? issue.row.created_at : issue.row.published_at
export function assertSlugFree(ctx: StoreCtx, newsletterId: string, slug: string, exceptId = '') {
  if (ctx.db.get('SELECT id FROM campaigns WHERE newsletter_id = ? AND (slug = ? OR id = ?) AND id != ?', newsletterId, slug, slug, exceptId) || ctx.db.get('SELECT id FROM website_posts WHERE newsletter_id = ? AND (slug = ? OR id = ?) AND id != ?', newsletterId, slug, slug, exceptId)) throw new AppError('slug_taken', 'That issue address is already in use.', 409)
}

export async function ensureAppUrl(ctx: StoreCtx) {
  if (!ctx.config.appUrl) {
    const values = await ctx.stores.control.getInstallSettings({ keys: ['app_url'] })
    if (values.app_url) ctx.config.appUrl = values.app_url.replace(/\/+$/, '')
  }
}
