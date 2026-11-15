import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'contactFields.list': { role: 'member' },
  'contactFields.create': { role: 'admin' },
  'contactFields.update': { role: 'admin' },
  'contactFields.delete': { role: 'admin' },
} satisfies PermissionEntries
