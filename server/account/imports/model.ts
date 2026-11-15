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
  consent: z.boolean().default(false).describe('Assert that active contacts consented elsewhere; never revives opt-outs'),
  statuses: z.enum(['preserve', 'activeOnly']).default('preserve').describe('Preserve opt-outs or skip inactive rows; neither option subscribes opt-outs'),
  defaultStatus: z.enum(['subscribed', 'unsubscribed', 'cleaned', 'pending']).default('pending').describe('Status for exports without a status column, especially Mailchimp split exports'),
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
  finished_at: number | null; error: string | null; uploaded_at: number | null
}
export const skipCountsSchema = z.record(z.string(), z.number())
export function serializeImport(r: ImportRow) {
  return { id: r.id, newsletterId: r.newsletter_id, status: r.status, preset: r.source_preset,
    mapping: mappingSchema.parse(JSON.parse(r.mapping)), options: optionsSchema.parse(JSON.parse(r.options)),
    totalRows: r.total_rows, processedRows: r.processed_rows, added: r.added, updated: r.updated,
    skipped: skipCountsSchema.parse(JSON.parse(r.skipped)), createdAt: r.created_at, finishedAt: r.finished_at, error: r.error }
}
