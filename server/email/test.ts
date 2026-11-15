import type { StoreCtx } from '../core/store.ts'
import { newId } from '../core/ids.ts'
import type { EmailProvider } from './index.ts'

/** Writes every message to the store's `outbox` table. The default provider, and the one tests read. */
export function testProvider(ctx: StoreCtx): EmailProvider {
  return {
    name: 'test',
    capabilities: { identities: false, events: false, idempotency: true },
    async send(msg) {
      const id = newId('out')
      ctx.db.run(
        'INSERT INTO outbox (id, to_email, subject, html, text, headers, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        msg.to,
        msg.subject,
        msg.html,
        msg.text,
        JSON.stringify(msg.headers),
        msg.meta.kind,
        ctx.now(),
      )
      return { ok: true, id }
    },
  }
}

export interface OutboxRow {
  id: string
  to_email: string
  subject: string
  html: string
  text: string
  headers: string
  kind: string
  created_at: number
}

export const readOutbox = (ctx: StoreCtx, to?: string): OutboxRow[] =>
  to ? ctx.db.all<OutboxRow>('SELECT * FROM outbox WHERE to_email = ? ORDER BY rowid', to) : ctx.db.all<OutboxRow>('SELECT * FROM outbox ORDER BY rowid')
