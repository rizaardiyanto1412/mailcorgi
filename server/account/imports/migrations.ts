import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  id: '2026-11-15-imports-checkpoints',
  sql: `
    ALTER TABLE imports ADD COLUMN uploaded_at INTEGER;
    ALTER TABLE imports ADD COLUMN headers TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE import_chunks ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE import_seen (
      import_id TEXT NOT NULL, email TEXT NOT NULL,
      PRIMARY KEY (import_id, email)
    );
    CREATE TABLE import_skips (
      import_id TEXT NOT NULL, row_number INTEGER NOT NULL, row TEXT NOT NULL,
      reason TEXT NOT NULL, suggestion TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (import_id, row_number)
    );
    CREATE TABLE import_dns (
      domain TEXT PRIMARY KEY, valid INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX imports_stalled ON imports(status, uploaded_at);
  `,
}]
