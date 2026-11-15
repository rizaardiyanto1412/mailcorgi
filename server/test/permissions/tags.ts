import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'tags.list': { role: 'member' },
  'tags.create': { role: 'admin' },
  'tags.update': { role: 'admin' },
  'tags.delete': { role: 'admin' },
} satisfies PermissionEntries
