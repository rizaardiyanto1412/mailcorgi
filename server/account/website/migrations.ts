import type { Migration } from '../../core/db.ts'

const bump = (expression: string) => `INSERT INTO website_cache_versions (newsletter_id, version) VALUES (${expression}, 1) ON CONFLICT(newsletter_id) DO UPDATE SET version = version + 1;`
export const migrations: readonly Migration[] = [{
  id: '2026-11-15-website-public-archive',
  sql: `
    CREATE TABLE website_hosts (newsletter_id TEXT PRIMARY KEY REFERENCES newsletters(id) ON DELETE CASCADE, hostname TEXT NOT NULL UNIQUE, token TEXT NOT NULL, verified_at INTEGER, cf_id TEXT);
    CREATE TABLE website_posts (id TEXT PRIMARY KEY, newsletter_id TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE, author_id TEXT, subject TEXT NOT NULL, slug TEXT NOT NULL, source TEXT NOT NULL, published_at INTEGER NOT NULL, web_visible INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, UNIQUE(newsletter_id, slug));
    CREATE TABLE website_cache_versions (newsletter_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE INDEX website_posts_published ON website_posts(newsletter_id, web_visible, published_at);
    ${['campaigns', 'authors', 'website_posts', 'website_hosts'].flatMap((table) => ['INSERT', 'UPDATE', 'DELETE'].map((event) => `CREATE TRIGGER website_${table}_${event.toLowerCase()} AFTER ${event === 'UPDATE' && table === 'campaigns' ? 'UPDATE OF author_id, kind, format, subject, preview_text, doc, source, html, text, slug, status, sent_at, published_at, web_visible' : event} ON ${table} BEGIN ${bump(`${event === 'DELETE' ? 'OLD' : 'NEW'}.newsletter_id`)} END;`)).join('\n')}
    CREATE TRIGGER website_newsletters_update AFTER UPDATE OF name, slug, description, language, logo_key, icon_key, theme, website, archived_at ON newsletters BEGIN ${bump('NEW.id')} END;
  `,
}]
