import type { Migration } from '../../core/db.ts'

export const migrations: readonly Migration[] = [
  { id: '2026-11-15-sending-delivery-attempts', sql: `
  ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX campaign_sends_release ON campaign_sends(campaign_id, state, release_at);
  ` },
]
