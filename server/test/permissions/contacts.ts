import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'contacts.list': { role: 'member' },
  'contacts.create': { role: 'admin' },
  'contacts.get': { role: 'member' },
  'contacts.update': { role: 'admin' },
  'contacts.unsubscribe': { role: 'admin' },
  'contacts.delete': { role: 'admin' },
  'contacts.bulk': { role: 'admin' },
  'contacts.export': { role: 'admin' },
} satisfies PermissionEntries
