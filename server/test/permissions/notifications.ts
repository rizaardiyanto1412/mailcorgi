import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'notifications.list': { role: 'member' },
  'notifications.markRead': { role: 'member' },
} satisfies PermissionEntries
