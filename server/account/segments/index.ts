import type { StoreCtx } from '../../core/store.ts'
import type { Param } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
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

const notBuilt = () => new AppError('not_built', 'Segments are not built yet.', 501)

/** Turns a filter into a WHERE clause over `contacts c`. Built by the segments unit. */
export function compileFilter(_filter: Filter | null, _newsletterId: string): { where: string; params: Param[] } {
  throw notBuilt()
}
export function audienceQuery(_ctx: StoreCtx, _newsletterId: string, _audience: Audience): { where: string; params: Param[] } {
  throw notBuilt()
}

export const segmentsModule = {
  name: 'segments',
  register(reg: AccountRegistrar) {
    reg.resolver('segment', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM segments WHERE id = ?', id)?.newsletter_id ?? null)
  },
}
