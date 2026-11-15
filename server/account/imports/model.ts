import { z } from 'zod'

const column = z.string().min(1).max(200)
export const mappingSchema = z.object({
  email: column.describe('Email column header'),
  name: column.optional().describe('Full name column header'),
  firstName: column.optional().describe('First name column header'),
  lastName: column.optional().describe('Last name column header'),
  status: column.optional().describe('Subscription status column header'),
  signupDate: column.optional().describe('Signup date column header'),
  unsubscribeDate: column.optional().describe('A populated unsubscribe date always overrides an active status'),
  tags: column.optional().describe('Comma or semicolon separated tag names'),
  fields: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), column).default({}).describe('Custom field keys mapped to CSV headers'),
})
export const optionsSchema = z.object({
  tagIds: z.array(z.string()).max(100).default([]).describe('Newsletter tag ids to add'),
  consent: z.boolean().default(false).describe('Assert that active contacts consented elsewhere; never revives opt-outs. Only rows whose status is subscribed (from the status column, or defaultStatus when no status column is mapped) become subscribed; every other active row is added as unconfirmed and receives no email'),
  statuses: z.enum(['preserve', 'activeOnly']).default('preserve').describe('Preserve opt-outs or skip inactive rows; neither option subscribes opt-outs'),
  defaultStatus: z.enum(['subscribed', 'unsubscribed', 'cleaned', 'pending']).default('pending').describe('Status for every row when no status column is mapped, especially Mailchimp split exports. The default, pending, adds contacts as unconfirmed: they receive no issues and no confirmation email. Use subscribed together with consent to add them as subscribed'),
})
export const rowsSchema = z.array(z.record(z.string().max(200), z.string().max(20_000))).min(1).max(500)
export type CsvRow = z.infer<typeof rowsSchema>[number]
export type Mapping = z.output<typeof mappingSchema>
export type Options = z.output<typeof optionsSchema>
export type ImportStatus = 'uploading' | 'queued' | 'processing' | 'completed' | 'canceled' | 'stalled' | 'failed'
export interface ImportRow {
  id: string; newsletter_id: string; status: ImportStatus; source_preset: string
  mapping: string; options: string; headers: string; total_rows: number; processed_rows: number
  added: number; updated: number; skipped: string; created_by: string; created_at: number
  finished_at: number | null; error: string | null; uploaded_at: number | null; added_detail: string
}

/** Why an added contact ended up unconfirmed, keyed as stored in `imports.added_detail`. */
export const UNCONFIRMED_REASONS = {
  no_status_column: 'no status column was mapped and “Status when no column exists” is Unconfirmed',
  pending_in_file: 'the file marks them as pending or unconfirmed',
  no_consent: 'consent was not confirmed for this import',
} as const
export type AddedKind = 'subscribed' | keyof typeof UNCONFIRMED_REASONS

/** How the added contacts split, with a plain note when some of them will receive nothing. Null for imports that predate the split. */
export function addedBreakdown(r: Pick<ImportRow, 'added' | 'added_detail'>) {
  const detail = z.record(z.string(), z.number()).catch({}).parse(JSON.parse(r.added_detail || '{}'))
  if (r.added > 0 && !Object.keys(detail).length) return null
  const reasons = Object.fromEntries(Object.keys(UNCONFIRMED_REASONS).filter((k) => detail[k]).map((k) => [k, detail[k]])) as Partial<Record<keyof typeof UNCONFIRMED_REASONS, number>>
  const unconfirmed = Object.values(reasons).reduce((a, b) => a + b, 0)
  const why = Object.keys(reasons).map((k) => UNCONFIRMED_REASONS[k as keyof typeof UNCONFIRMED_REASONS])
  const note = unconfirmed ? `${unconfirmed.toLocaleString('en-US')} ${unconfirmed === 1 ? 'contact was' : 'contacts were'} added as unconfirmed because ${why.join(', and ')}. Unconfirmed contacts receive no issues and no confirmation email.` : null
  return { subscribed: detail.subscribed ?? 0, unconfirmed, unconfirmedReasons: reasons, note }
}
export const skipCountsSchema = z.record(z.string(), z.number())
export function serializeImport(r: ImportRow) {
  return { id: r.id, newsletterId: r.newsletter_id, status: r.status, preset: r.source_preset,
    mapping: mappingSchema.parse(JSON.parse(r.mapping)), options: optionsSchema.parse(JSON.parse(r.options)),
    totalRows: r.total_rows, processedRows: r.processed_rows, added: r.added, addedBreakdown: addedBreakdown(r), updated: r.updated,
    skipped: skipCountsSchema.parse(JSON.parse(r.skipped)), createdAt: r.created_at, finishedAt: r.finished_at, error: r.error }
}

const NOTHING = 'Unconfirmed contacts receive no issues and no confirmation email.'
/** What status active rows will get, in words, for the mapping step. */
export function statusOutcome(mapping: Pick<Mapping, 'status'>, options: Pick<Options, 'consent' | 'defaultStatus' | 'statuses'>): { tone: 'ok' | 'warn'; text: string } {
  if (mapping.status) return options.consent
    ? { tone: 'ok', text: 'Rows the status column marks as subscribed are added as subscribed. Rows marked pending are added as unconfirmed and receive nothing.' }
    : { tone: 'warn', text: `Consent is not confirmed, so every active row is added as unconfirmed. ${NOTHING} Tick the consent box if they opted in elsewhere.` }
  if (options.defaultStatus === 'unsubscribed' || options.defaultStatus === 'cleaned') return { tone: 'ok', text: options.statuses === 'activeOnly' ? 'No status column is mapped, so every row counts as inactive and is skipped.' : `No status column is mapped, so every row is imported as ${options.defaultStatus} and kept suppressed.` }
  if (options.defaultStatus === 'subscribed' && options.consent) return { tone: 'ok', text: 'No status column is mapped. Every row is added as subscribed.' }
  if (options.defaultStatus === 'subscribed') return { tone: 'warn', text: `No status column is mapped and consent is not confirmed, so every row is added as unconfirmed. ${NOTHING} Tick the consent box if they opted in elsewhere.` }
  return { tone: 'warn', text: `No status column is mapped, so every row is added as unconfirmed. ${NOTHING} If they opted in elsewhere, set “Status when no column exists” to Subscribed and confirm their consent.` }
}
