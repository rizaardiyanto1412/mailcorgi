import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'account.profile': { role: 'user' },
  'account.updateProfile': { role: 'user' },
  'account.changePassword': { role: 'user' },
  'account.requestEmailChange': { role: 'user' },
  'account.confirmEmailChange': { role: 'user' },
  'account.sessions': { role: 'user' },
  'account.revokeSession': { role: 'user' },
  'account.delete': { role: 'owner' },
} satisfies PermissionEntries
