import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'authors.uploadAvatar': { role: 'admin' },
  'authors.list': { role: 'member' },
  'authors.create': { role: 'admin' },
  'authors.update': { role: 'admin' },
  'authors.delete': { role: 'admin' },
} satisfies PermissionEntries
