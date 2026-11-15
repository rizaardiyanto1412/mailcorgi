import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  id: '2026-11-15-signup-forms-and-mail',
  sql: `
    CREATE TABLE signup_settings (
      newsletter_id TEXT PRIMARY KEY REFERENCES newsletters(id) ON DELETE CASCADE,
      settings TEXT NOT NULL
    );
    CREATE TABLE signup_mail (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('confirm', 'welcome')),
      token TEXT NOT NULL DEFAULT '',
      message TEXT,
      provider TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
      attempt_at INTEGER,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX signup_mail_contact ON signup_mail(newsletter_id, contact_id, kind);
  `,
}]
