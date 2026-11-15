import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'stats.overview': { role: 'member' },
  'stats.report': { role: 'member' },
  'stats.recipients': { role: 'member' },
  'stats.exportRecipients': { role: 'admin' },
} satisfies PermissionEntries
