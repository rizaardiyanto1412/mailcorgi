import type { StoreCtx } from '../../core/store.ts'
import type { Budget, JobResult } from '../../core/jobs.ts'
import { hmac, toHex } from '../../core/crypto.ts'
import { ZodError } from 'zod'
import { subscribe, suppress, setContactStatus, ensureTags, isDeleted, isSuppressed, validateFields } from '../contacts/index.ts'
import { reserveContacts } from '../usage/index.ts'
import { notify } from '../notifications/index.ts'
import { cleanEmail } from './cleaning.ts'
import { mapStatus, parseSignupDate } from './presets.ts'
import { addedBreakdown, mappingSchema, optionsSchema, rowsSchema, skipCountsSchema, type AddedKind, type ImportRow, type CsvRow } from './model.ts'

interface Chunk { seq: number; rows: string; position: number; done: number }
const again = (ctx: StoreCtx): JobResult => ({ again: ctx.now() + 1000 })

export async function processImport(ctx: StoreCtx, { importId }: { importId: string }, budget: Budget): Promise<JobResult> {
  const imp = ctx.db.get<ImportRow>("SELECT * FROM imports WHERE id = ? AND status IN ('queued', 'processing')", importId)
  if (!imp) return 'done'
  const chunk = ctx.db.get<Chunk>('SELECT * FROM import_chunks WHERE import_id = ? AND done = 0 ORDER BY seq LIMIT 1', imp.id)
  if (!chunk) {
    ctx.db.tx(() => {
      if (!ctx.db.run("UPDATE imports SET status = 'completed', finished_at = ? WHERE id = ? AND newsletter_id = ? AND status IN ('queued', 'processing')", ctx.now(), imp.id, imp.newsletter_id).changes) return
      const split = addedBreakdown(imp)
      const added = split && split.unconfirmed ? `${split.subscribed} contacts added and subscribed. ${split.note}` : `${imp.added} contacts added.`
      const updated = imp.updated ? ` ${imp.updated} existing ${imp.updated === 1 ? 'contact' : 'contacts'} updated to subscribed.` : ''
      notify(ctx, { userId: imp.created_by, kind: 'import_finished', title: 'Import finished', body: `${added}${updated} ${imp.processed_rows - imp.added - imp.updated} rows skipped.`, href: '/imports?import=' + imp.id })
      ctx.db.run('DELETE FROM import_seen WHERE import_id = ?', imp.id)
    })
    return 'done'
  }
  if (budget.expired() || !budget.take(1)) return again(ctx)
  const rows = rowsSchema.parse(JSON.parse(chunk.rows))
  const mapping = mappingSchema.parse(JSON.parse(imp.mapping))
  const options = optionsSchema.parse(JSON.parse(imp.options))
  const hashes = await Promise.all(rows.map(async (row) => toHex(await hmac(ctx.keys.suppression, (row[mapping.email] ?? '').trim().toLowerCase()))))
  if (budget.expired()) return again(ctx)
  const global = new Set((await ctx.stores.control.checkSuppressed({ emailHashes: hashes })).suppressed)
  ctx.db.run("UPDATE imports SET status = 'processing' WHERE id = ? AND newsletter_id = ? AND status = 'queued'", imp.id, imp.newsletter_id)
  for (let pos = chunk.position; pos < rows.length; pos++) {
    if (budget.expired()) return again(ctx)
    const row = rows[pos]
    const cleaned = cleanEmail(row[mapping.email] ?? '')
    const mappedStatus = mapping.status ? mapStatus(row[mapping.status] ?? '', mapping.status) : options.defaultStatus
    const optOut = mapping.unsubscribeDate ? row[mapping.unsubscribeDate]?.trim() : ''
    const status = optOut && ['subscribed', 'pending', 'unknown'].includes(mappedStatus) ? 'unsubscribed' : mappedStatus
    const inactive = ['unsubscribed', 'cleaned', 'bounced', 'complained'].includes(status)
    let reason = cleaned.reason
    let at = mapping.signupDate ? parseSignupDate(row[mapping.signupDate] ?? '') : null
    if (at !== null && (!Number.isFinite(at) || at < 0 || at > ctx.now())) { reason ??= 'invalid_date'; at = null }
    if (status === 'unknown') reason ??= 'unknown_status'
    if (global.has(hashes[pos])) reason ??= 'global_suppression'
    if (!reason && !inactive) {
      const cached = ctx.db.get<{ valid: number }>('SELECT valid FROM import_dns WHERE domain = ? AND expires_at > ?', cleaned.domain, ctx.now())
      let valid = cached?.valid
      if (valid === undefined) {
        if (!budget.take(1)) return again(ctx)
        const mx = await ctx.platform.resolveDns(cleaned.domain, 'MX')
        valid = mx.some((record) => record.trim() !== '.' && record.trim() !== '0 .' && record.trim() !== '') ? 1 : 0
        ctx.db.run('INSERT INTO import_dns (domain, valid, expires_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET valid = excluded.valid, expires_at = excluded.expires_at', cleaned.domain, valid, ctx.now() + 86_400_000)
      }
      if (!valid) reason = 'no_mx'
    }
    const committed = ctx.db.tx(() => {
      const current = ctx.db.get<ImportRow>('SELECT * FROM imports WHERE id = ? AND newsletter_id = ?', imp.id, imp.newsletter_id)
      const position = ctx.db.get<{ position: number }>('SELECT position FROM import_chunks WHERE import_id = ? AND seq = ?', imp.id, chunk.seq)?.position
      if (!current || !['queued', 'processing'].includes(current.status)) return false
      if (position !== pos) return true
      let added = 0
      let updated = 0
      let addedKind: AddedKind | null = null
      let finalReason = reason
      const existing = ctx.db.get<{ id: string; status: string }>('SELECT id, status FROM contacts WHERE newsletter_id = ? AND email = ?', imp.newsletter_id, cleaned.email)
      if (inactive && cleaned.reason !== 'invalid_syntax') {
        // Opt-outs take precedence even when another row in the file already added this address.
        const result = options.statuses === 'preserve' && !existing && !global.has(hashes[pos]) ? subscribe(ctx, { newsletterId: imp.newsletter_id, email: cleaned.email, source: 'import:' + imp.source_preset, consent: 'pending', at: at ?? undefined }) : null
        const contactId = existing?.id ?? (result?.created ? result.contact.id : null)
        if (contactId && (existing?.status === 'subscribed' || existing?.status === 'unconfirmed' || result?.created)) {
          const target = status === 'bounced' ? 'bounced' : status === 'complained' ? 'complained' : status === 'cleaned' ? 'cleaned' : 'unsubscribed'
          setContactStatus(ctx, contactId, target, { reason: 'import', at: at ?? ctx.now() })
        }
        suppress(ctx, { email: cleaned.email, newsletterId: status === 'bounced' || status === 'complained' ? null : imp.newsletter_id, reason: status === 'bounced' ? 'hard_bounce' : status === 'complained' ? 'complaint' : status === 'cleaned' ? 'cleaned' : 'unsubscribed' })
        finalReason = options.statuses === 'preserve' ? 'imported_' + status : 'inactive_status'
      } else if (inactive) finalReason ??= 'inactive_status'
      if (!finalReason) {
        if (ctx.db.get('SELECT 1 FROM import_seen WHERE import_id = ? AND email = ?', imp.id, cleaned.email)) finalReason = 'duplicate_file'
        else if (isDeleted(ctx, cleaned.email, imp.newsletter_id)) finalReason = 'deleted'
        else if (isSuppressed(ctx, cleaned.email, imp.newsletter_id)) finalReason = 'suppressed'
        // The owner asserts consent, so an unconfirmed contact becomes subscribed; inactive ones were handled above.
        else if (existing && !(existing.status === 'unconfirmed' && options.consent && status === 'subscribed')) finalReason = 'duplicate_existing'
        else {
          try {
            const insertActive = (): Pick<ReturnType<typeof subscribe>, 'created' | 'outcome'> => {
              const fields: Record<string, string | number | boolean> = {}
              const definitions = ctx.db.all<{ key: string; type: string }>('SELECT key, type FROM contact_fields WHERE newsletter_id = ?', imp.newsletter_id)
              for (const [key, header] of Object.entries(mapping.fields)) {
                const raw = row[header] ?? ''
                if (!raw) continue
                const def = definitions.find((d) => d.key === key)
                if (def?.type === 'number') {
                  if (!Number.isFinite(Number(raw))) throw new Error('Invalid field')
                  fields[key] = Number(raw)
                } else if (def?.type === 'boolean') {
                  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(raw.toLowerCase())) throw new Error('Invalid field')
                  fields[key] = ['true', '1', 'yes'].includes(raw.toLowerCase())
                } else fields[key] = raw
              }
              validateFields(ctx, imp.newsletter_id, fields)
              const name = (mapping.name ? row[mapping.name] ?? '' : [mapping.firstName ? row[mapping.firstName] : '', mapping.lastName ? row[mapping.lastName] : ''].filter(Boolean).join(' ')).trim()
              if (name.length > 200) throw new Error('Invalid name')
              const names = (mapping.tags ? row[mapping.tags] ?? '' : '').split(/[,;]/).map((t) => t.trim()).filter(Boolean)
              if (!existing && !reserveContacts(ctx, 1)) return { created: false, outcome: 'limit' }
              const tagIds = [...options.tagIds, ...ensureTags(ctx, imp.newsletter_id, names)]
              return subscribe(ctx, { newsletterId: imp.newsletter_id, email: cleaned.email, name: existing && !name ? undefined : name, fields, tags: tagIds, source: 'import:' + imp.source_preset, consent: options.consent && status === 'subscribed' ? 'asserted' : 'pending', at: at ?? undefined })
            }
            const result = insertActive()
            if (result.outcome === 'limit') finalReason = 'contact_limit'
            else if (result.outcome === 'suppressed') finalReason = 'suppressed_or_deleted'
            else if (result.created) {
              added = 1
              addedKind = result.outcome === 'subscribed' ? 'subscribed' : status === 'subscribed' ? 'no_consent' : mapping.status ? 'pending_in_file' : 'no_status_column'
            }
            else if (existing && result.outcome === 'subscribed') updated = 1
            else finalReason = 'duplicate_existing'
          } catch (error) {
            if (error instanceof ZodError || error instanceof Error && ('status' in error ? error.status === 400 : error.message.startsWith('Invalid'))) finalReason = 'invalid_field'
            else throw error
          }
        }
      }
      ctx.db.run('INSERT OR IGNORE INTO import_seen (import_id, email) VALUES (?, ?)', imp.id, cleaned.email)
      const counts = skipCountsSchema.parse(JSON.parse(current.skipped))
      if (finalReason) {
        counts[finalReason] = (counts[finalReason] ?? 0) + 1
        ctx.db.run('INSERT OR IGNORE INTO import_skips (import_id, row_number, row, reason, suggestion) VALUES (?, ?, ?, ?, ?)', imp.id, current.processed_rows + 1, JSON.stringify(row), finalReason, cleaned.suggestion)
      }
      const detail = JSON.parse(current.added_detail || '{}') as Record<string, number>
      if (addedKind) detail[addedKind] = (detail[addedKind] ?? 0) + 1
      ctx.db.run('UPDATE imports SET processed_rows = processed_rows + 1, added = added + ?, updated = updated + ?, added_detail = ?, skipped = ? WHERE id = ? AND newsletter_id = ?', added, updated, JSON.stringify(detail), JSON.stringify(counts), imp.id, imp.newsletter_id)
      ctx.db.run('UPDATE import_chunks SET position = ?, done = ? WHERE import_id = ? AND seq = ?', pos + 1, pos + 1 === rows.length ? 1 : 0, imp.id, chunk.seq)
      return true
    })
    if (!committed) return 'done'
  }
  return again(ctx)
}

export interface SkippedRow { row_number: number; row: string; reason: string; suggestion: string }
export const parseCsvRow = (text: string): CsvRow => rowsSchema.element.parse(JSON.parse(text))
