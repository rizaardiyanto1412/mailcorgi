import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  // The per-contact email log (`sends.list` with `email`) is the hot path of the CRM view: it reads one
  // address's deliveries newest first. No other index on deliveries leads with the address.
  id: '2026-11-27-sends-email-log',
  sql: 'CREATE INDEX deliveries_email_sent ON deliveries(email, sent_at DESC, id DESC);',
}]
