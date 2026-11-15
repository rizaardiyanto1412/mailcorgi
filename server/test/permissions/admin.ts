import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'admin.accounts': { role: 'installAdmin' },
  'admin.accountSummary': { role: 'installAdmin' },
  'admin.block': { role: 'installAdmin' },
  'admin.unblock': { role: 'installAdmin' },
  'admin.deleteAccount': { role: 'installAdmin' },
  'admin.alerts': { role: 'installAdmin' },
  'admin.resolveAlert': { role: 'installAdmin' },
  'admin.deadJobs': { role: 'installAdmin' },
  'admin.settings': { role: 'installAdmin' },
  'admin.setSetting': { role: 'installAdmin' },
  'admin.suppressions': { role: 'installAdmin' },
} satisfies PermissionEntries
