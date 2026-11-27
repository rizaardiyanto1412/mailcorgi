import type { Migration } from '../../core/db.ts'

/** `send_format`: how the email goes out. `html` is the themed email, `plain` a personal-looking plain text one. */
export const migrations: readonly Migration[] = [
  { id: '2026-11-27-campaigns-send-format', sql: "ALTER TABLE campaigns ADD COLUMN send_format TEXT NOT NULL DEFAULT 'html' CHECK(send_format IN ('html', 'plain'));" },
  // `hide_unsubscribe_footer`: a plain send without its closing unsubscribe line. The List-Unsubscribe headers are not affected.
  { id: '2026-11-27-campaigns-hide-unsubscribe-footer', sql: 'ALTER TABLE campaigns ADD COLUMN hide_unsubscribe_footer INTEGER NOT NULL DEFAULT 0 CHECK(hide_unsubscribe_footer IN (0, 1));' },
  // Optional per-campaign sender override. Each column falls back to the newsletter's own value while NULL (an empty `from_name` is a real value: no display name).
  { id: '2026-11-27-campaigns-from-domain-id', sql: 'ALTER TABLE campaigns ADD COLUMN from_domain_id TEXT;' },
  { id: '2026-11-27-campaigns-from-local', sql: 'ALTER TABLE campaigns ADD COLUMN from_local TEXT;' },
  { id: '2026-11-27-campaigns-from-name', sql: 'ALTER TABLE campaigns ADD COLUMN from_name TEXT;' },
]
