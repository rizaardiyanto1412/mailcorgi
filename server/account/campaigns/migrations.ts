import type { Migration } from '../../core/db.ts'

/** `send_format`: how the email goes out. `html` is the themed email, `plain` a personal-looking plain text one. */
export const migrations: readonly Migration[] = [
  { id: '2026-11-27-campaigns-send-format', sql: "ALTER TABLE campaigns ADD COLUMN send_format TEXT NOT NULL DEFAULT 'html' CHECK(send_format IN ('html', 'plain'));" },
]
