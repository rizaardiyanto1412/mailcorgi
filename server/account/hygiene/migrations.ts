import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  id: '2026-11-15-hygiene-reminders-and-protection',
  sql: `
    ALTER TABLE contacts ADD COLUMN strict_ignored_streak INTEGER NOT NULL DEFAULT 0;
    UPDATE contacts SET strict_ignored_streak = ignored_streak;
    ALTER TABLE deliveries ADD COLUMN hygiene_epoch INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE hygiene_requests (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      sent_at INTEGER,
      issued_at INTEGER,
      clean_at INTEGER,
      PRIMARY KEY(campaign_id, contact_id)
    );
    CREATE INDEX hygiene_requests_contact ON hygiene_requests(contact_id, sent_at);
    CREATE INDEX hygiene_requests_due ON hygiene_requests(clean_at);
    CREATE TABLE hygiene_paused (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
      previous_status TEXT NOT NULL,
      start_payload TEXT
    );
    CREATE INDEX hygiene_deliveries_recent ON deliveries(hygiene_epoch, sent_at DESC, id DESC) WHERE sent_at IS NOT NULL;
  `,
}]
