import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'apikeys.create': { role: 'owner' },
  'apikeys.list': { role: 'owner' },
  'apikeys.rename': { role: 'owner' },
  'apikeys.revoke': { role: 'owner' },
} satisfies PermissionEntries
