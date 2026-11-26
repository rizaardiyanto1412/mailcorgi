import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'tags.list': { role: 'member' },
  'tags.create': { role: 'admin' },
  'tags.update': { role: 'admin' },
  // The fixture's draft sequence enters by this tag, so an allowed caller reaches the guard.
  'tags.delete': { role: 'admin', error: 'tag_in_use' },
} satisfies PermissionEntries
