import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'dev.outbox': { role: 'owner' },
  'dev.ingest': { role: 'owner', input: { events: [{ id: 'evt_example', type: 'delivered', recipient: 'reader@example.com' }] } },
  'dev.controlOutbox': { role: 'installAdmin' },
} satisfies PermissionEntries
