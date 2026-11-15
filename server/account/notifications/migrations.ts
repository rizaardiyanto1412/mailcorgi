import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  id: '2026-11-15-notifications-email-cooldowns',
  sql: `ALTER TABLE notifications ADD COLUMN email_attempted_at INTEGER;
    CREATE TABLE notification_events (id TEXT PRIMARY KEY, notification_id TEXT NOT NULL);
    CREATE TABLE notification_emails (kind TEXT PRIMARY KEY, reserved_at INTEGER NOT NULL);
    CREATE TABLE notification_receipts (notification_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY(notification_id, user_id));`,
}]
