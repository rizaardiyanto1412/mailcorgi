import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'signup.get': { role: 'admin' },
  'signup.preview': { role: 'admin', input: { settings: {} } },
  'signup.update': { role: 'admin', input: { settings: {}, doubleOptIn: true } },
  'signup.saveWelcome': { role: 'admin', input: { enabled: true, subject: 'Welcome', revision: null } },
  'signup.sendWelcome': { role: 'admin', input: { contactId: 'ct_missing' }, error: 'not_found' },
} satisfies PermissionEntries
