import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [{
  id: '2026-11-15-stats-report-caches',
  sql: `CREATE TABLE stats_reports (campaign_id TEXT PRIMARY KEY, newsletter_id TEXT NOT NULL, timeline TEXT NOT NULL, providers TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE stats_sources (newsletter_id TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL, added INTEGER NOT NULL, removed INTEGER NOT NULL, PRIMARY KEY(newsletter_id, day, source));
    CREATE TABLE stats_website (newsletter_id TEXT NOT NULL, day TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(newsletter_id, day, dimension, value));
    CREATE INDEX stats_reports_newsletter ON stats_reports(newsletter_id);
    CREATE INDEX stats_campaign_order ON campaigns(newsletter_id, kind, created_at DESC);`,
}, {
  // Growth by source used to change only in the rollup, which recounts the last three days. A
  // running import showed a stale part of its rows, and imported signup dates older than three days
  // never showed at all. Each event now bumps its own day at once, as daily_stats does; the rollup
  // still repairs the recent window. A full recount picks up history written before this migration.
  id: '2026-11-16-stats-live-sources',
  sql: `CREATE TRIGGER stats_sources_live AFTER INSERT ON events WHEN NEW.type IN ('signup','confirm','unsubscribe','cleaned','bounce','complaint') BEGIN
      INSERT INTO stats_sources (newsletter_id, day, source, added, removed)
      VALUES (NEW.newsletter_id, strftime('%Y-%m-%d', NEW.at / 1000, 'unixepoch'),
        COALESCE(json_extract(NEW.data, '$.source'), (SELECT source FROM contacts WHERE id = NEW.contact_id AND newsletter_id = NEW.newsletter_id), 'unknown'),
        NEW.type IN ('signup','confirm') AND COALESCE(json_extract(NEW.data, '$.pending'), 0) = 0,
        NEW.type IN ('unsubscribe','cleaned','bounce','complaint'))
      ON CONFLICT(newsletter_id, day, source) DO UPDATE SET added = added + excluded.added, removed = removed + excluded.removed;
    END;
    DELETE FROM stats_sources;
    INSERT INTO stats_sources (newsletter_id, day, source, added, removed)
      SELECT e.newsletter_id, strftime('%Y-%m-%d', e.at / 1000, 'unixepoch'), COALESCE(json_extract(e.data, '$.source'), c.source, 'unknown'),
      SUM(e.type IN ('signup','confirm') AND COALESCE(json_extract(e.data, '$.pending'), 0) = 0), SUM(e.type IN ('unsubscribe','cleaned','bounce','complaint'))
      FROM events e LEFT JOIN contacts c ON c.id = e.contact_id AND c.newsletter_id = e.newsletter_id WHERE e.type IN ('signup','confirm','unsubscribe','cleaned','bounce','complaint') GROUP BY 1, 2, 3;`,
}]
