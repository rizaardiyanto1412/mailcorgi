import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  id: '2026-11-15-stats-report-caches',
  sql: `CREATE TABLE stats_reports (campaign_id TEXT PRIMARY KEY, newsletter_id TEXT NOT NULL, timeline TEXT NOT NULL, providers TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE stats_sources (newsletter_id TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL, added INTEGER NOT NULL, removed INTEGER NOT NULL, PRIMARY KEY(newsletter_id, day, source));
    CREATE TABLE stats_website (newsletter_id TEXT NOT NULL, day TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(newsletter_id, day, dimension, value));
    CREATE INDEX stats_reports_newsletter ON stats_reports(newsletter_id);
    CREATE INDEX stats_campaign_order ON campaigns(newsletter_id, kind, created_at DESC);`,
}]
