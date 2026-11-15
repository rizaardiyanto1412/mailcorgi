import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'domains.list': { role: 'owner' },
  'domains.add': { role: 'owner' },
  'domains.check': { role: 'owner' },
  'domains.delete': { role: 'owner' },
  'domains.senders': { role: 'admin' },
} satisfies PermissionEntries
