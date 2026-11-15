import type { Migration } from '../../core/db.ts'

const ACTIVE = "('subscribed', 'unconfirmed')"
const bump = (delta: string) => `UPDATE account_meta SET value = CAST(value AS INTEGER) + (${delta}) WHERE key = 'active_contacts';`

/**
 * `account_meta.active_contacts` counts contacts that use a plan slot. Triggers keep it in the same
 * transaction as every insert, delete and status change, whichever code path makes it.
 */
export const migrations: readonly Migration[] = [{
  id: '2026-11-16-contacts-active-counter',
  sql: `
    INSERT INTO account_meta (key, value) SELECT 'active_contacts', CAST(COUNT(*) AS TEXT) FROM contacts WHERE status IN ${ACTIVE}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    CREATE TRIGGER contacts_active_insert AFTER INSERT ON contacts WHEN NEW.status IN ${ACTIVE} BEGIN ${bump('1')} END;
    CREATE TRIGGER contacts_active_delete AFTER DELETE ON contacts WHEN OLD.status IN ${ACTIVE} BEGIN ${bump('-1')} END;
    CREATE TRIGGER contacts_active_status AFTER UPDATE OF status ON contacts WHEN (NEW.status IN ${ACTIVE}) != (OLD.status IN ${ACTIVE})
      BEGIN ${bump(`(NEW.status IN ${ACTIVE}) - (OLD.status IN ${ACTIVE})`)} END;
  `,
}]
