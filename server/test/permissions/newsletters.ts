import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'newsletters.uploadImage': { role: 'admin' },
  'newsletters.create': { role: 'owner' },
  'newsletters.list': { role: 'member' },
  'newsletters.get': { role: 'member' },
  'newsletters.update': { role: 'admin' },
  'newsletters.setSlug': { role: 'admin' },
  'newsletters.archive': { role: 'owner' },
  'newsletters.unarchive': { role: 'owner' },
  'newsletters.delete': { role: 'owner', error: 'confirm_mismatch', input: { confirmName: 'Not the name' } },
} satisfies PermissionEntries
