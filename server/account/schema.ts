import { JOBS_SQL } from '../core/jobs.ts'

/** Account store migrations. Append only once merged to main. */
export const accountMigrations: readonly string[] = [
  `
  CREATE TABLE account_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE newsletters (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'en',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    from_name TEXT NOT NULL DEFAULT '',
    from_local TEXT NOT NULL DEFAULT '',
    domain_id TEXT,
    reply_to TEXT NOT NULL DEFAULT '',
    postal_address TEXT NOT NULL DEFAULT '',
    logo_key TEXT,
    icon_key TEXT,
    theme TEXT NOT NULL DEFAULT '{}',
    website TEXT NOT NULL DEFAULT '{}',
    double_opt_in INTEGER NOT NULL DEFAULT 1,
    welcome TEXT NOT NULL DEFAULT '{}',
    hygiene TEXT NOT NULL DEFAULT '{}',
    tracking TEXT NOT NULL DEFAULT '{}',
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE authors (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    avatar_key TEXT,
    links TEXT NOT NULL DEFAULT '{}',
    user_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (newsletter_id, slug)
  );
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unconfirmed',
    source TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '{}',
    subscribed_at INTEGER,
    confirmed_at INTEGER,
    unsubscribed_at INTEGER,
    unsubscribe_reason TEXT,
    bounced_at INTEGER,
    complained_at INTEGER,
    last_sent_at INTEGER,
    last_opened_at INTEGER,
    last_clicked_at INTEGER,
    sent_count INTEGER NOT NULL DEFAULT 0,
    open_count INTEGER NOT NULL DEFAULT 0,
    click_count INTEGER NOT NULL DEFAULT 0,
    ignored_streak INTEGER NOT NULL DEFAULT 0,
    keep_asked_at INTEGER,
    engaged_score REAL NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'other',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (newsletter_id, email)
  );
  CREATE INDEX contacts_status ON contacts(newsletter_id, status);
  CREATE INDEX contacts_created ON contacts(newsletter_id, created_at);
  CREATE TABLE contact_fields (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    UNIQUE (newsletter_id, key)
  );
  CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (newsletter_id, name)
  );
  CREATE TABLE contact_tags (
    contact_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (contact_id, tag_id)
  );
  CREATE INDEX contact_tags_tag ON contact_tags(tag_id);
  CREATE TABLE segments (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    name TEXT NOT NULL,
    filter TEXT NOT NULL DEFAULT 'null',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX segments_newsletter ON segments(newsletter_id);
  CREATE TABLE suppressions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    newsletter_id TEXT,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX suppressions_account ON suppressions(email) WHERE newsletter_id IS NULL;
  CREATE UNIQUE INDEX suppressions_newsletter ON suppressions(newsletter_id, email) WHERE newsletter_id IS NOT NULL;
  CREATE TABLE deleted_contacts (
    email_hash TEXT NOT NULL,
    newsletter_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (email_hash, newsletter_id)
  );
  CREATE TABLE imports (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source_preset TEXT NOT NULL DEFAULT '',
    mapping TEXT NOT NULL DEFAULT '{}',
    options TEXT NOT NULL DEFAULT '{}',
    total_rows INTEGER NOT NULL DEFAULT 0,
    processed_rows INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    skipped TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT
  );
  CREATE INDEX imports_newsletter ON imports(newsletter_id, created_at);
  CREATE TABLE import_chunks (
    import_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    rows TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (import_id, seq)
  );
  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    author_id TEXT,
    kind TEXT NOT NULL DEFAULT 'issue',
    format TEXT NOT NULL DEFAULT 'doc',
    subject TEXT NOT NULL DEFAULT '',
    preview_text TEXT NOT NULL DEFAULT '',
    doc TEXT,
    source TEXT,
    html TEXT,
    text TEXT,
    slug TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    pause_reason TEXT,
    audience TEXT NOT NULL DEFAULT '{}',
    scheduled_at INTEGER,
    send_started_at INTEGER,
    sent_at INTEGER,
    published_at INTEGER,
    web_visible INTEGER NOT NULL DEFAULT 1,
    stats TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX campaigns_newsletter ON campaigns(newsletter_id, status, updated_at);
  CREATE UNIQUE INDEX campaigns_slug ON campaigns(newsletter_id, slug) WHERE slug != '';
  CREATE INDEX campaigns_scheduled ON campaigns(scheduled_at) WHERE status = 'scheduled';
  CREATE TABLE campaign_sends (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    step INTEGER NOT NULL,
    kind TEXT NOT NULL,
    planned INTEGER NOT NULL DEFAULT 0,
    release_at INTEGER,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX campaign_sends_campaign ON campaign_sends(campaign_id, step);
  CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    send_id TEXT,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    provider_message_id TEXT,
    error TEXT,
    attempt_token TEXT,
    attempt_at INTEGER,
    queued_at INTEGER NOT NULL,
    sent_at INTEGER,
    delivered_at INTEGER,
    opened_at INTEGER,
    clicked_at INTEGER,
    bounced_at INTEGER,
    complained_at INTEGER,
    unsubscribed_at INTEGER,
    open_count INTEGER NOT NULL DEFAULT 0,
    click_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (campaign_id, contact_id)
  );
  CREATE INDEX deliveries_status ON deliveries(campaign_id, status);
  CREATE INDEX deliveries_message ON deliveries(provider_message_id);
  CREATE INDEX deliveries_contact ON deliveries(contact_id);
  CREATE TABLE provider_events (
    id TEXT PRIMARY KEY,
    delivery_id INTEGER,
    type TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    unique_clicks INTEGER NOT NULL DEFAULT 0,
    UNIQUE (campaign_id, url)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    newsletter_id TEXT NOT NULL,
    contact_id TEXT,
    campaign_id TEXT,
    delivery_id INTEGER,
    data TEXT NOT NULL DEFAULT '{}',
    at INTEGER NOT NULL
  );
  CREATE INDEX events_newsletter ON events(newsletter_id, at);
  CREATE INDEX events_campaign ON events(campaign_id, type);
  CREATE INDEX events_contact ON events(contact_id, at);
  CREATE TABLE daily_stats (
    newsletter_id TEXT NOT NULL,
    day TEXT NOT NULL,
    subscribed INTEGER NOT NULL DEFAULT 0,
    unsubscribed INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0,
    opens INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    complaints INTEGER NOT NULL DEFAULT 0,
    page_views INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (newsletter_id, day)
  );
  CREATE TABLE page_views (
    id INTEGER PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    campaign_id TEXT,
    path TEXT NOT NULL,
    referrer_host TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
  CREATE INDEX page_views_newsletter ON page_views(newsletter_id, at);
  CREATE TABLE domains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_identity TEXT NOT NULL DEFAULT '{}',
    records TEXT NOT NULL DEFAULT '[]',
    last_checked_at INTEGER,
    verified_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE uploads (
    key TEXT PRIMARY KEY,
    newsletter_id TEXT,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    last4 TEXT NOT NULL,
    access TEXT NOT NULL DEFAULT 'full',
    created_by TEXT NOT NULL,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    kind TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    href TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_user ON notifications(user_id, read_at, created_at);
  CREATE TABLE usage (
    period TEXT PRIMARY KEY,
    emails_sent INTEGER NOT NULL DEFAULT 0,
    contacts_peak INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    text TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE _blobs (
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    data BLOB NOT NULL,
    PRIMARY KEY (key, seq)
  ) WITHOUT ROWID;
  ${JOBS_SQL}
  `,
  `
  CREATE INDEX contacts_created_page ON contacts(newsletter_id, created_at, id);
  CREATE INDEX contacts_name_page ON contacts(newsletter_id, name, id);
  CREATE INDEX contacts_email_page ON contacts(newsletter_id, email, id);
  CREATE INDEX contacts_email_status ON contacts(email, status);
  CREATE INDEX contacts_active ON contacts(status);
  CREATE INDEX events_contact_page ON events(newsletter_id, contact_id, id);
  CREATE INDEX deliveries_contact_campaign ON deliveries(contact_id, campaign_id);
  CREATE INDEX campaigns_recent_issues ON campaigns(newsletter_id, kind, status, sent_at, id);
  `,
]
