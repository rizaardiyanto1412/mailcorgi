/**
 * Deleting a newsletter. The action marks it (`deleting_at`, archived) and enqueues one durable job.
 * The job removes the newsletter's rows in chunks, children before parents, its images, and then
 * (through control RPCs the job makes, per architecture 11.5) its team grants, invites and directory
 * row. The newsletter row goes last, so a retry always finds where it left off.
 */
import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError, notFound } from '../../core/http.ts'
import type { Budget } from '../../core/jobs.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { AccountRegistrar } from '../rpc.ts'

const CHUNK = 500
const BLOBS_PER_RUN = 20
const ROWS_PER_RUN = 20_000

/** Rows to remove, in order. Each selects at most `LIMIT ?` rowids of one table for newsletter `?`. */
const byCampaign = (table: string) => `SELECT t.rowid AS r FROM ${table} t JOIN campaigns c ON c.id = t.campaign_id WHERE c.newsletter_id = ? LIMIT ?`
const byImport = (table: string) => `SELECT t.rowid AS r FROM ${table} t JOIN imports i ON i.id = t.import_id WHERE i.newsletter_id = ? LIMIT ?`
const direct = (table: string) => `SELECT rowid AS r FROM ${table} WHERE newsletter_id = ? LIMIT ?`
export const DELETE_STEPS: { table: string; select: string }[] = [
  { table: 'provider_events', select: 'SELECT p.rowid AS r FROM provider_events p JOIN deliveries d ON d.id = p.delivery_id JOIN campaigns c ON c.id = d.campaign_id WHERE c.newsletter_id = ? LIMIT ?' },
  { table: 'deliveries', select: byCampaign('deliveries') },
  { table: 'campaign_sends', select: byCampaign('campaign_sends') },
  { table: 'links', select: byCampaign('links') },
  { table: 'hygiene_paused', select: byCampaign('hygiene_paused') },
  { table: 'hygiene_requests', select: 'SELECT h.rowid AS r FROM hygiene_requests h JOIN contacts c ON c.id = h.contact_id WHERE c.newsletter_id = ? LIMIT ?' },
  { table: 'contact_tags', select: 'SELECT ct.rowid AS r FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.newsletter_id = ? LIMIT ?' },
  { table: 'contact_tags', select: 'SELECT ct.rowid AS r FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id WHERE c.newsletter_id = ? LIMIT ?' },
  { table: 'import_chunks', select: byImport('import_chunks') },
  { table: 'import_seen', select: byImport('import_seen') },
  { table: 'import_skips', select: byImport('import_skips') },
  ...['events', 'page_views', 'daily_stats', 'stats_sources', 'stats_website', 'stats_reports', 'signup_mail', 'signup_settings', 'segments', 'contacts', 'tags', 'contact_fields', 'imports', 'campaigns', 'website_posts', 'authors', 'website_hosts', 'suppressions', 'deleted_contacts', 'website_cache_versions'].map((table) => ({ table, select: direct(table) })),
]

/** Queued work for the newsletter's campaigns and imports: it would only fail once the rows are gone. */
const STALE_JOBS = `SELECT j.id FROM jobs j WHERE j.kind != 'newsletters.delete' AND (instr(j.payload, ?1) > 0
  OR EXISTS (SELECT 1 FROM campaigns c WHERE c.newsletter_id = ?1 AND instr(j.payload, c.id) > 0)
  OR EXISTS (SELECT 1 FROM imports i WHERE i.newsletter_id = ?1 AND instr(j.payload, i.id) > 0)) LIMIT ?2`

/** Blob keys: campaign images store `<newsletter>/<file>`, logos and avatars the full `<account>/<key>`. */
const blobKey = (ctx: StoreCtx, key: string) => (key.startsWith(`${ctx.accountId}/`) ? key : `${ctx.accountId}/${key}`)

function deleteRows(ctx: StoreCtx, newsletterId: string, budget: Budget): 'more' | 'empty' {
  let removed = 0
  ctx.db.tx(() => {
    const jobs = ctx.db.all<{ id: string }>(STALE_JOBS, newsletterId, CHUNK)
    for (const { id } of jobs) ctx.db.run('DELETE FROM jobs WHERE id = ?', id)
    removed += jobs.length
  })
  for (const step of DELETE_STEPS) {
    while (removed < ROWS_PER_RUN && !budget.expired()) {
      const n = ctx.db.tx(() => ctx.db.run(`DELETE FROM ${step.table} WHERE rowid IN (${step.select})`, newsletterId, CHUNK).changes)
      removed += n
      if (n < CHUNK) break
    }
    if (removed >= ROWS_PER_RUN || budget.expired()) return 'more'
  }
  return DELETE_STEPS.some((step) => ctx.db.get(step.select, newsletterId, 1)) ? 'more' : 'empty'
}

export function registerNewsletterDelete(reg: AccountRegistrar) {
  reg.job<{ newsletterId: string }>('newsletters.delete', async (ctx, { newsletterId }, budget) => {
    const row = ctx.db.get<{ id: string; deleting_at: number | null }>('SELECT id, deleting_at FROM newsletters WHERE id = ?', newsletterId)
    if (!row || row.deleting_at === null) return 'done'
    const soon = { again: ctx.now() + 1000 }

    const uploads = ctx.db.all<{ key: string }>('SELECT key FROM uploads WHERE newsletter_id = ? LIMIT ?', newsletterId, BLOBS_PER_RUN)
    for (const { key } of uploads) {
      if (budget.take(1) < 1) return soon
      // Blob first: a failure keeps the row, so the next run tries the file again instead of leaking it.
      await ctx.platform.blobs.delete(blobKey(ctx, key))
      ctx.db.run('DELETE FROM uploads WHERE key = ? AND newsletter_id = ?', key, newsletterId)
    }
    if (uploads.length === BLOBS_PER_RUN) return { again: ctx.now() }

    const cfIds = ctx.db.all<{ cf_id: string }>('SELECT cf_id FROM website_hosts WHERE newsletter_id = ? AND cf_id IS NOT NULL', newsletterId)
    if (cfIds.length) ctx.db.tx(() => {
      for (const { cf_id } of cfIds) ctx.jobs.enqueue('website.deleteHost', { id: cf_id }, { dedupeKey: `website.deleteHost:${cf_id}` })
      ctx.db.run('UPDATE website_hosts SET cf_id = NULL WHERE newsletter_id = ?', newsletterId)
    })

    if (deleteRows(ctx, newsletterId, budget) === 'more') return { again: ctx.now() }

    if (budget.take(2) < 2) return soon
    await ctx.stores.control.removeNewsletterAccess({ accountId: ctx.accountId!, newsletterId })
    await ctx.stores.control.removeSite({ accountId: ctx.accountId!, newsletterId })
    ctx.db.tx(() => {
      // Anything written while the RPCs ran is caught by the next run.
      if (DELETE_STEPS.some((step) => ctx.db.get(step.select, newsletterId, 1)) || ctx.db.get('SELECT key FROM uploads WHERE newsletter_id = ? LIMIT 1', newsletterId)) return
      ctx.db.run('DELETE FROM newsletters WHERE id = ? AND deleting_at IS NOT NULL', newsletterId)
    })
    return ctx.db.get('SELECT id FROM newsletters WHERE id = ?', newsletterId) ? { again: ctx.now() } : 'done'
  })
}

export const deleteNewsletterAction = defineAction({
  name: 'newsletters.delete',
  description: 'Permanently delete a newsletter with its contacts, campaigns, stats, imports, website, images and team access. This cannot be undone. Refused while a campaign is sending or scheduled. The removal runs in the background; calling again is safe.',
  scope: 'account',
  role: 'owner',
  effect: 'write',
  // No `resource`: the newsletter resolver hides a newsletter being deleted, and a repeat call must still answer.
  input: z.object({
    newsletterId: z.string().min(1).describe('The newsletter id'),
    confirmName: z.string().max(200).describe('The newsletter name, typed exactly, to confirm the deletion'),
  }),
  rest: { method: 'DELETE', path: '/newsletters/:newsletterId' },
  mcp: { title: 'Delete a newsletter permanently', destructive: true },
  handler: (ctx, input) => ctx.db.tx(() => {
    const row = ctx.db.get<{ name: string; deleting_at: number | null }>('SELECT name, deleting_at FROM newsletters WHERE id = ?', input.newsletterId)
    if (!row) throw notFound('That newsletter')
    if (input.confirmName.trim() !== row.name.trim()) throw new AppError('confirm_mismatch', 'Type the newsletter name exactly to delete it.', 400)
    if (row.deleting_at !== null) return { deleting: true }
    const busy = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM campaigns WHERE newsletter_id = ? AND status IN ('sending', 'scheduled')", input.newsletterId)!.n
    if (busy) throw new AppError('campaign_active', 'A campaign is sending or scheduled. Cancel it or let it finish, then delete the newsletter.', 409)
    ctx.db.run('UPDATE newsletters SET deleting_at = ?, archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?', ctx.now(), ctx.now(), ctx.now(), input.newsletterId)
    ctx.jobs.enqueue('newsletters.delete', { newsletterId: input.newsletterId }, { dedupeKey: `newsletters.delete:${input.newsletterId}` })
    return { deleting: true }
  }),
})
