import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'suppressions.list': { role: 'owner' },
  'suppressions.add': { role: 'owner' },
  'suppressions.remove': { role: 'owner' },
} satisfies PermissionEntries
