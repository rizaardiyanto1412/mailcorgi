import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'segments.list': { role: 'member' },
  'segments.create': { role: 'admin' },
  'segments.update': { role: 'admin' },
  'segments.delete': { role: 'admin' },
  'segments.count': { role: 'member' },
} satisfies PermissionEntries
