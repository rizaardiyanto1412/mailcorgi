import type { Migration } from '../core/db.ts'
import { JOBS_SQL } from '../core/jobs.ts'

/** Control store base migrations. Fixed ids preserve the legacy positional history. */
export const controlMigrations: readonly Migration[] = [
  { id: '0001-base', sql: `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    email_verified_at INTEGER,
    is_install_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE login_codes (
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (email, purpose)
  );
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    block_reason TEXT,
    policy_version INTEGER NOT NULL DEFAULT 1,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_period_end INTEGER,
    billing_provider TEXT,
    billing_customer_id TEXT,
    billing_subscription_id TEXT,
    billing_status TEXT,
    billing_paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX accounts_owner ON accounts(owner_user_id);
  CREATE TABLE memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    newsletter_id TEXT,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX memberships_unique ON memberships(user_id, account_id, COALESCE(newsletter_id, ''));
  CREATE INDEX memberships_account ON memberships(account_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    newsletter_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER
  );
  CREATE INDEX invites_email ON invites(email);
  CREATE TABLE sites (
    newsletter_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    custom_host TEXT UNIQUE,
    host_verified_at INTEGER
  );
  CREATE INDEX sites_account ON sites(account_id);
  CREATE TABLE global_suppressions (
    email_hash TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    until INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE install_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE billing_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    processed_at INTEGER
  );
  CREATE TABLE admin_alerts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    account_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX admin_alerts_open ON admin_alerts(resolved_at, created_at);
  CREATE TABLE usage_snapshots (
    account_id TEXT NOT NULL,
    period TEXT NOT NULL,
    contacts INTEGER NOT NULL DEFAULT 0,
    emails_sent INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, period)
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
  ${JOBS_SQL}
  ` },
  { id: '0002-base', sql: `
  ALTER TABLE accounts ADD COLUMN billing_event_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN billing_grace_until INTEGER;
  ALTER TABLE accounts ADD COLUMN blocked_at INTEGER;
  CREATE TABLE account_email_changes (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  ` },
  // The job queue is a handful of rows; the alarm's MIN(COALESCE(locked_until, run_at)) never used
  // the run_at index, and every reschedule paid a row for it.
  { id: '0003-base', sql: `
  DROP INDEX IF EXISTS jobs_due;
  ` },
]
