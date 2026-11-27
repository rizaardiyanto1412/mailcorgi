import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [
  { id: '2026-11-15-sending-delivery-attempts', sql: `
  ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX campaign_sends_release ON campaign_sends(campaign_id, state, release_at);
  ` },
  // The optional 30-day copy of an email as the provider accepted it. It lives apart from `deliveries`
  // so the hot delivery rows stay small. The expiry index drives the durable purge, the contact index
  // erases a deleted contact's copies, and the cascade removes a copy with its delivery.
  { id: '2026-11-28-sending-delivery-content', sql: `
  CREATE TABLE delivery_content (
    delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    subject TEXT NOT NULL,
    html TEXT,
    text TEXT NOT NULL
  );
  CREATE INDEX delivery_content_expiry ON delivery_content(expires_at);
  CREATE INDEX delivery_content_contact ON delivery_content(contact_id);
  ` },
]
