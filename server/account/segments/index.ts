import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import type { Param } from '../../core/db.ts'
import { defineAction } from '../../core/actions.ts'
import { AppError, notFound } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import type { ContactStatus } from '../contacts/index.ts'
import type { AccountRegistrar } from '../rpc.ts'

export type Filter = { all: Filter[] } | { any: Filter[] } | { not: Filter } | Condition
export type Condition =
  | { field: 'status'; in: ContactStatus[] }
  | { field: 'tag'; id: string }
  | { field: 'custom'; key: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'set' | 'unset'; value?: string | number | boolean }
  | { field: 'subscribedAt' | 'lastOpenedAt' | 'lastClickedAt' | 'lastSentAt'; op: 'before' | 'after' | 'withinDays' | 'never'; value?: number }
  | { field: 'source' | 'provider'; in: string[] }
  | { field: 'email'; op: 'contains' | 'endsWith'; value: string }
  | { field: 'engagement'; op: 'openedLast' | 'clickedLast' | 'ignoredLast'; issues: number }
export type Audience = { segmentId?: string; tagIds?: string[]; engaged?: boolean; all?: boolean; exclude?: { segmentIds?: string[]; tagIds?: string[] } }

const statuses = z.enum(['unconfirmed', 'subscribed', 'unsubscribed', 'bounced', 'complained', 'cleaned'])
const conditionSchema = z.union([
  z.object({ field: z.literal('status'), in: z.array(statuses).max(6) }),
  z.object({ field: z.literal('tag'), id: z.string().min(1) }),
  z.object({ field: z.literal('custom'), key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), op: z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'set', 'unset']), value: z.union([z.string().max(1000), z.number().finite(), z.boolean()]).optional() }),
  z.object({ field: z.enum(['subscribedAt', 'lastOpenedAt', 'lastClickedAt', 'lastSentAt']), op: z.enum(['before', 'after', 'withinDays', 'never']), value: z.number().finite().nonnegative().optional() }),
  z.object({ field: z.enum(['source', 'provider']), in: z.array(z.string().max(200)).max(20) }),
  z.object({ field: z.literal('email'), op: z.enum(['contains', 'endsWith']), value: z.string().max(320) }),
  z.object({ field: z.literal('engagement'), op: z.enum(['openedLast', 'clickedLast', 'ignoredLast']), issues: z.number().int().min(1).max(10000) }),
])
const recursiveFilter: z.ZodType<Filter> = z.lazy(() => z.union([
  z.object({ all: z.array(recursiveFilter).max(20) }),
  z.object({ any: z.array(recursiveFilter).max(20) }),
  z.object({ not: recursiveFilter }), conditionSchema,
]))
function boundedTree(value: unknown, depth = 0, budget = { left: 40 }): boolean {
  if (depth > 8 || --budget.left < 0) return false
  if (!value || typeof value !== 'object') return true
  if ('all' in value && Array.isArray(value.all)) return value.all.every((v) => boundedTree(v, depth + 1, budget))
  if ('any' in value && Array.isArray(value.any)) return value.any.every((v) => boundedTree(v, depth + 1, budget))
  if ('not' in value) return boundedTree(value.not, depth + 1, budget)
  return true
}
export const filterSchema = z.unknown().refine(boundedTree, 'Use at most 40 conditions and 8 levels.').pipe(recursiveFilter)
const invalidFilter = () => new AppError('invalid_input', 'That filter is invalid or too large.', 400)

export function compileFilter(filter: Filter | null, newsletterId: string): { where: string; params: Param[] } {
  return compileAt(filter, newsletterId, Date.now())
}
function compileAt(filter: Filter | null, newsletterId: string, now: number) {
  const params: Param[] = [newsletterId]
  const bind = (v: Param) => { params.push(v); return '?' }
  function node(f: Filter): string {
    if ('all' in f) return '(' + (f.all.map(node).join(' AND ') || '1') + ')'
    if ('any' in f) return '(' + (f.any.map(node).join(' OR ') || '0') + ')'
    if ('not' in f) return `(NOT (${node(f.not)}))`
    switch (f.field) {
      case 'status': case 'source': case 'provider':
        return f.in.length ? `c.${f.field} IN (${f.in.map(bind).join(',')})` : '0'
      case 'tag':
        return `EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.newsletter_id = c.newsletter_id AND t.id = ${bind(f.id)})`
      case 'custom': {
        const path = '$.' + f.key
        if (f.op === 'set' || f.op === 'unset') return `json_type(c.fields, ${bind(path)}) IS ${f.op === 'set' ? 'NOT ' : ''}NULL`
        if (f.value === undefined) throw invalidFilter()
        const expr = `json_extract(c.fields, ${bind(path)})`
        if (f.op === 'contains') return `COALESCE(instr(CAST(${expr} AS TEXT), ${bind(String(f.value))}) > 0, 0)`
        const op = { eq: '=', neq: '!=', gt: '>', lt: '<' }[f.op]
        return `COALESCE(${expr} ${op} ${bind(f.value)}, 0)`
      }
      case 'subscribedAt': case 'lastOpenedAt': case 'lastClickedAt': case 'lastSentAt': {
        const col = { subscribedAt: 'subscribed_at', lastOpenedAt: 'last_opened_at', lastClickedAt: 'last_clicked_at', lastSentAt: 'last_sent_at' }[f.field]
        if (f.op === 'never') return `c.${col} IS NULL`
        if (f.value === undefined) throw invalidFilter()
        return `COALESCE(c.${col} ${f.op === 'before' ? '<' : '>'} ${bind(f.op === 'withinDays' ? now - f.value * 86400000 : f.value)}, 0)`
      }
      case 'email':
        return f.op === 'contains' ? `instr(c.email, ${bind(f.value.toLowerCase())}) > 0` : `substr(c.email, length(c.email) - length(${bind(f.value.toLowerCase())}) + 1) = ${bind(f.value.toLowerCase())}`
      case 'engagement': {
        const recent = `SELECT id FROM campaigns WHERE newsletter_id = c.newsletter_id AND kind = 'issue' AND status = 'sent' ORDER BY sent_at DESC, id DESC LIMIT ${bind(f.issues)}`
        if (f.op === 'ignoredLast') return `(SELECT COUNT(*) FROM deliveries d WHERE d.contact_id = c.id AND d.campaign_id IN (${recent}) AND d.sent_at IS NOT NULL AND d.opened_at IS NULL AND d.clicked_at IS NULL) = ${bind(f.issues)}`
        return `EXISTS (SELECT 1 FROM deliveries d WHERE d.contact_id = c.id AND d.campaign_id IN (${recent}) AND d.${f.op === 'openedLast' ? 'opened_at' : 'clicked_at'} IS NOT NULL)`
      }
    }
  }
  const parsed = filter === null ? null : filterSchema.safeParse(filter)
  if (parsed && !parsed.success) throw invalidFilter()
  const where = 'c.newsletter_id = ?' + (parsed?.success ? ` AND (${node(parsed.data)})` : '')
  if (params.length > 85) throw invalidFilter()
  return { where, params }
}

function savedFilter(ctx: StoreCtx, newsletterId: string, id: string): Filter {
  const row = ctx.db.get<{ filter: string }>('SELECT filter FROM segments WHERE id = ? AND newsletter_id = ?', id, newsletterId)
  if (!row) throw notFound('That segment')
  return filterSchema.parse(JSON.parse(row.filter))
}
export function audienceQuery(ctx: StoreCtx, newsletterId: string, audience: Audience): { where: string; params: Param[] } {
  const all: Filter[] = []
  if (audience.segmentId) all.push(savedFilter(ctx, newsletterId, audience.segmentId))
  if (audience.tagIds?.length) all.push({ any: audience.tagIds.map((id) => ({ field: 'tag', id })) })
  if (audience.engaged) all.push({ any: [{ field: 'lastOpenedAt', op: 'withinDays', value: 90 }, { field: 'lastClickedAt', op: 'withinDays', value: 90 }] })
  for (const id of audience.exclude?.segmentIds ?? []) all.push({ not: savedFilter(ctx, newsletterId, id) })
  for (const id of audience.exclude?.tagIds ?? []) all.push({ not: { field: 'tag', id } })
  const q = compileAt({ all }, newsletterId, ctx.now())
  return { where: `${q.where} AND c.status = 'subscribed' AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email AND (s.newsletter_id IS NULL OR s.newsletter_id = c.newsletter_id))`, params: q.params }
}
const newsletterId = z.string().min(1).describe('The newsletter id')
const segmentId = z.string().min(1).describe('The saved segment id')
const name = z.string().trim().min(1).max(120).describe('The segment name')
const filter = filterSchema.describe('Contact conditions, combined with all, any and not')
interface SegmentRow { id: string; name: string; filter: string; created_at: number; updated_at: number }
const serialize = (r: SegmentRow) => ({ id: r.id, name: r.name, filter: filterSchema.parse(JSON.parse(r.filter)), createdAt: r.created_at, updatedAt: r.updated_at })
export const segmentsModule = {
  name: 'segments',
  register(reg: AccountRegistrar) {
    reg.resolver('segment', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM segments WHERE id = ?', id)?.newsletter_id ?? null)
    return reg.actions(
      defineAction({ name: 'segments.list', description: 'List saved contact filters.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/segments' }, mcp: { title: 'List segments', destructive: false }, handler: (ctx, i) => ({ segments: ctx.db.all<SegmentRow>('SELECT * FROM segments WHERE newsletter_id = ? ORDER BY name, id', i.newsletterId).map(serialize) }) }),
      defineAction({ name: 'segments.create', description: 'Save a contact filter.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, name, filter }), rest: { method: 'POST', path: '/newsletters/:newsletterId/segments' }, mcp: { title: 'Create a segment', destructive: false }, handler: (ctx, i) => {
        compileAt(i.filter, i.newsletterId, ctx.now())
        const id = newId('seg')
        ctx.db.run('INSERT INTO segments (id, newsletter_id, name, filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, i.newsletterId, i.name, JSON.stringify(i.filter), ctx.now(), ctx.now())
        return { id, name: i.name, filter: i.filter }
      } }),
      defineAction({ name: 'segments.update', description: 'Change a saved contact filter.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'segment', param: 'segmentId' }, input: z.object({ newsletterId, segmentId, name, filter }), rest: { method: 'PATCH', path: '/newsletters/:newsletterId/segments/:segmentId' }, mcp: { title: 'Update a segment', destructive: false }, handler: (ctx, i) => {
        compileAt(i.filter, i.newsletterId, ctx.now())
        ctx.db.run('UPDATE segments SET name = ?, filter = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?', i.name, JSON.stringify(i.filter), ctx.now(), i.segmentId, i.newsletterId)
        return { id: i.segmentId, name: i.name, filter: i.filter }
      } }),
      defineAction({ name: 'segments.delete', description: 'Delete a saved contact filter.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'segment', param: 'segmentId' }, input: z.object({ newsletterId, segmentId }), rest: { method: 'DELETE', path: '/newsletters/:newsletterId/segments/:segmentId' }, mcp: { title: 'Delete a segment', destructive: true }, handler: (ctx, i) => { ctx.db.run('DELETE FROM segments WHERE id = ? AND newsletter_id = ?', i.segmentId, i.newsletterId); return { deleted: true } } }),
      defineAction({ name: 'segments.count', description: 'Count contacts matching a live filter.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, filter: filter.nullable().describe('The filter to count, or null for every contact') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/segments/count' }, mcp: { title: 'Count matching contacts', destructive: false }, handler: (ctx, i) => { const q = compileAt(i.filter, i.newsletterId, ctx.now()); return { count: ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${q.where}`, ...q.params)!.n } } }),
    )
  },
}
