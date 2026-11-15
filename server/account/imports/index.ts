import { z } from 'zod'
import { defineAction, runAction } from '../../core/actions.ts'
import { AppError, notFound, unauthorized } from '../../core/http.ts'
import type { StoreCtx } from '../../core/store.ts'
import { newId } from '../../core/ids.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { csvCell } from '../contacts/index.ts'
import { notify } from '../notifications/index.ts'
import { MAX_ATTEMPTS } from '../../core/jobs.ts'
import { migrations } from './migrations.ts'
import { mappingSchema, optionsSchema, rowsSchema, serializeImport, type ImportRow } from './model.ts'
import { presetNames } from './presets.ts'
import { parseCsvRow, processImport, type SkippedRow } from './process.ts'

const newsletterId = z.string().min(1).describe('The newsletter id')
const importId = z.string().min(1).describe('The import id')
const identity = { newsletterId, importId }
const csvPageSchema = z.object({ csv: z.string(), nextRow: z.number().nullable() })
function getImport(ctx: StoreCtx, i: { newsletterId: string; importId: string }): ImportRow {
  const row = ctx.db.get<ImportRow>('SELECT * FROM imports WHERE id = ? AND newsletter_id = ?', i.importId, i.newsletterId)
  if (!row) throw notFound('That import')
  return row
}
function requireUploading(row: ImportRow) {
  if (row.status !== 'uploading') throw new AppError('invalid_transition', 'This import is no longer accepting rows.', 409)
}
function skipPage(ctx: StoreCtx, i: { newsletterId: string; importId: string; afterRow: number; limit: number }) {
  const imp = getImport(ctx, i)
  const headers = z.array(z.string()).parse(JSON.parse(imp.headers))
  const rows = ctx.db.all<SkippedRow>('SELECT s.* FROM import_skips s JOIN imports i ON i.id = s.import_id WHERE s.import_id = ? AND i.newsletter_id = ? AND s.row_number > ? ORDER BY s.row_number LIMIT ?', imp.id, imp.newsletter_id, i.afterRow, i.limit + 1)
  const page = rows.slice(0, i.limit)
  return { csv: (i.afterRow ? '' : ['Row', ...headers, 'Reason', 'Suggestion'].map(csvCell).join(',') + '\r\n') + page.map((r) => {
    const row = parseCsvRow(r.row)
    return [r.row_number, ...headers.map((h) => row[h] ?? ''), r.reason, r.suggestion].map(csvCell).join(',') + '\r\n'
  }).join(''), nextRow: rows.length > i.limit ? page.at(-1)?.row_number ?? null : null }
}

export const importsModule = {
  name: 'imports',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.resolver('import', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM imports WHERE id = ?', id)?.newsletter_id ?? null)
    reg.job<{ importId: string }>('import.process', async (ctx, input, budget, job) => {
      try {
        return await processImport(ctx, input, budget)
      } catch (error) {
        if (job.attempts + 1 >= MAX_ATTEMPTS) ctx.db.tx(() => {
          const row = ctx.db.get<ImportRow>("SELECT * FROM imports WHERE id = ? AND status IN ('queued', 'processing')", input.importId)
          if (!row) return
          ctx.db.run("UPDATE imports SET status = 'failed', error = 'Import stopped after repeated processing failures.', finished_at = ? WHERE id = ? AND newsletter_id = ?", ctx.now(), row.id, row.newsletter_id)
          notify(ctx, { userId: row.created_by, kind: 'import_failed', title: 'Import stopped', body: 'Some rows could not be processed. Review the import report.', href: '/imports?import=' + row.id })
        })
        throw error
      }
    })
    reg.job<{ importId: string }>('import.sweep', async (ctx, { importId }) => {
      const row = ctx.db.get<ImportRow>("SELECT * FROM imports WHERE id = ? AND status = 'uploading'", importId)
      if (!row) return 'done'
      const expires = (row.uploaded_at ?? row.created_at) + 3_600_000
      if (expires > ctx.now()) return { again: expires }
      ctx.db.run("UPDATE imports SET status = 'stalled', finished_at = ?, error = 'Upload stopped for an hour.' WHERE id = ? AND newsletter_id = ? AND status = 'uploading'", ctx.now(), row.id, row.newsletter_id)
      return 'done'
    })
    reg.routes((app) => {
      app.get('/api/actions/imports.skipped', async (c) => {
        const actor = c.get('actor')
        if (!actor) throw unauthorized()
        const input = { newsletterId: c.req.query('newsletterId'), importId: c.req.query('importId'), afterRow: 0, limit: 500 }
        const ctx = c.get('ctx')
        let page = csvPageSchema.parse(await runAction(ctx, 'imports.skipped', input, actor))
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              controller.enqueue(new TextEncoder().encode(page.csv))
              if (page.nextRow === null) { controller.close(); return }
              page = csvPageSchema.parse(await runAction(ctx, 'imports.skipped', { ...input, afterRow: page.nextRow }, actor))
            } catch (error) { controller.error(error) }
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="skipped-rows.csv"', 'cache-control': 'no-store' } })
      })
    })
    return reg.actions(
      defineAction({ name: 'imports.create', description: 'Begin a resumable CSV import. Upload chunks, then start processing.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, preset: z.enum(presetNames).default('generic').describe('The source export platform'), mapping: mappingSchema.describe('CSV column mapping'), options: optionsSchema.default({ tagIds: [], consent: false, statuses: 'preserve', defaultStatus: 'pending' }).describe('Cleaning, opt-out and consent options') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/imports' }, mcp: { title: 'Create import', destructive: false }, handler: (ctx, i, actor) => ctx.db.tx(() => {
        for (const id of i.options.tagIds) if (!ctx.db.get('SELECT id FROM tags WHERE id = ? AND newsletter_id = ?', id, i.newsletterId)) throw notFound('That tag')
        for (const key of Object.keys(i.mapping.fields)) if (!ctx.db.get('SELECT id FROM contact_fields WHERE newsletter_id = ? AND key = ?', i.newsletterId, key)) throw notFound('That custom field')
        const id = newId('imp')
        ctx.db.run("INSERT INTO imports (id, newsletter_id, status, source_preset, mapping, options, created_by, created_at, uploaded_at) VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?, ?)", id, i.newsletterId, i.preset, JSON.stringify(i.mapping), JSON.stringify(i.options), actor.userId, ctx.now(), ctx.now())
        ctx.jobs.enqueue('import.sweep', { importId: id }, { runAt: ctx.now() + 3_600_000, dedupeKey: 'import.sweep:' + id })
        return serializeImport(getImport(ctx, { newsletterId: i.newsletterId, importId: id }))
      }) }),
      defineAction({ name: 'imports.addChunk', description: 'Upload at most 500 rows. Repeating the same sequence and data is a no-op; conflicting data is rejected.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'import', param: 'importId' }, input: z.object({ ...identity, seq: z.number().int().min(0).max(1_000_000).describe('Zero-based chunk sequence'), rows: rowsSchema.describe('CSV records keyed by their original headers') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/imports/:importId/chunks' }, mcp: { title: 'Upload import chunk', destructive: false }, handler: (ctx, i) => ctx.db.tx(() => {
        const imp = getImport(ctx, i)
        const payload = JSON.stringify(i.rows.map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))))
        if (new TextEncoder().encode(payload).length > 900_000) throw new AppError('too_large', 'This chunk is too large. Shorten the CSV cells.', 413)
        const existing = ctx.db.get<{ rows: string }>('SELECT rows FROM import_chunks WHERE import_id = ? AND seq = ?', imp.id, i.seq)
        if (existing) {
          if (existing.rows !== payload) throw new AppError('chunk_conflict', 'This sequence already contains different rows.', 409)
          return { accepted: false, totalRows: imp.total_rows }
        }
        requireUploading(imp)
        const headers = Object.keys(i.rows[0]).sort()
        const serializedHeaders = JSON.stringify(headers)
        if (i.rows.some((row) => JSON.stringify(Object.keys(row).sort()) !== serializedHeaders) || imp.headers !== '[]' && imp.headers !== serializedHeaders) throw new AppError('inconsistent_columns', 'CSV rows must have the same column headers.', 400)
        if (!headers.includes(mappingSchema.parse(JSON.parse(imp.mapping)).email)) throw new AppError('missing_email_column', 'The mapped email column is missing.', 400)
        ctx.db.run('UPDATE imports SET headers = ? WHERE id = ? AND newsletter_id = ?', serializedHeaders, imp.id, imp.newsletter_id)
        ctx.db.run('INSERT INTO import_chunks (import_id, seq, rows) VALUES (?, ?, ?)', imp.id, i.seq, payload)
        ctx.db.run('UPDATE imports SET total_rows = total_rows + ?, uploaded_at = ? WHERE id = ? AND newsletter_id = ?', i.rows.length, ctx.now(), imp.id, imp.newsletter_id)
        return { accepted: true, totalRows: imp.total_rows + i.rows.length }
      }) }),
      defineAction({ name: 'imports.start', description: 'Seal the upload and queue processing. Missing chunks or a row-count mismatch are rejected.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'import', param: 'importId' }, input: z.object({ ...identity, totalRows: z.number().int().min(0).describe('Expected total number of CSV records') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/imports/:importId/start' }, mcp: { title: 'Start import', destructive: false }, handler: (ctx, i) => ctx.db.tx(() => {
        const row = getImport(ctx, i)
        if (row.status !== 'uploading') {
          if (['queued', 'processing', 'completed'].includes(row.status) && row.total_rows === i.totalRows) return serializeImport(row)
          requireUploading(row)
        }
        const chunks = ctx.db.get<{ n: number; max: number | null }>('SELECT COUNT(*) AS n, MAX(seq) AS max FROM import_chunks WHERE import_id = ?', row.id)!
        if (row.total_rows !== i.totalRows || chunks.max !== null && chunks.max + 1 !== chunks.n) throw new AppError('incomplete_upload', 'Some rows or chunks are missing. Resume the upload first.', 409)
        ctx.db.run("UPDATE imports SET status = 'queued' WHERE id = ? AND newsletter_id = ?", row.id, row.newsletter_id)
        ctx.jobs.cancelByKey('import.sweep:' + row.id)
        ctx.jobs.enqueue('import.process', { importId: row.id }, { dedupeKey: 'import.process:' + row.id })
        return serializeImport(getImport(ctx, i))
      }) }),
      defineAction({ name: 'imports.cancel', description: 'Cancel an upload or import. Contacts already processed stay in the newsletter.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'import', param: 'importId' }, input: z.object(identity), rest: { method: 'POST', path: '/newsletters/:newsletterId/imports/:importId/cancel' }, mcp: { title: 'Cancel import', destructive: true }, handler: (ctx, i) => ctx.db.tx(() => {
        const row = getImport(ctx, i)
        ctx.db.run("UPDATE imports SET status = 'canceled', finished_at = ? WHERE id = ? AND newsletter_id = ? AND status IN ('uploading', 'queued', 'processing')", ctx.now(), row.id, row.newsletter_id)
        ctx.jobs.cancelByKey('import.process:' + row.id)
        ctx.jobs.cancelByKey('import.sweep:' + row.id)
        return serializeImport(getImport(ctx, i))
      }) }),
      defineAction({ name: 'imports.get', description: 'Read import progress and counts by skip reason, including uploaded sequences for resuming.', scope: 'account', role: 'admin', effect: 'read', resource: { type: 'import', param: 'importId' }, input: z.object(identity), rest: { method: 'GET', path: '/newsletters/:newsletterId/imports/:importId' }, mcp: { title: 'Get import', destructive: false }, handler: (ctx, i) => ({ ...serializeImport(getImport(ctx, i)), chunks: ctx.db.all<{ seq: number; done: number; position: number }>('SELECT seq, done, position FROM import_chunks WHERE import_id = ? ORDER BY seq', i.importId) }) }),
      defineAction({ name: 'imports.list', description: 'List recent imports for this newsletter.', scope: 'account', role: 'admin', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, before: z.number().int().optional().describe('Only imports created before this timestamp'), limit: z.number().int().min(1).max(100).default(30).describe('Maximum imports per page') }), rest: { method: 'GET', path: '/newsletters/:newsletterId/imports' }, mcp: { title: 'List imports', destructive: false }, handler: (ctx, i) => ({ imports: ctx.db.all<ImportRow>('SELECT * FROM imports WHERE newsletter_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?', i.newsletterId, i.before ?? Number.MAX_SAFE_INTEGER, i.limit).map(serializeImport) }) }),
      defineAction({ name: 'imports.skipped', description: 'Download a page of skipped rows as formula-safe CSV.', scope: 'account', role: 'admin', effect: 'read', resource: { type: 'import', param: 'importId' }, input: z.object({ ...identity, afterRow: z.number().int().min(0).default(0).describe('Last row number from the preceding page'), limit: z.number().int().min(1).max(500).default(500).describe('Maximum skipped rows per page') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/imports/:importId/skipped' }, mcp: { title: 'Export skipped rows', destructive: false }, handler: skipPage }),
    )
  },
}
