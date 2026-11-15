import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  id: '2026-11-15-admin-alert-email-cooldowns',
  sql: `CREATE TABLE admin_alert_emails (kind TEXT PRIMARY KEY, reserved_at INTEGER NOT NULL);
    CREATE TABLE admin_alert_email_attempts (alert_id TEXT NOT NULL, recipient TEXT NOT NULL, PRIMARY KEY(alert_id, recipient));`,
}]
