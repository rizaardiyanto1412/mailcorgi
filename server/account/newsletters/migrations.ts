import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [
  { id: '2026-11-16-newsletters-deleting', sql: 'ALTER TABLE newsletters ADD COLUMN deleting_at INTEGER;' },
]
