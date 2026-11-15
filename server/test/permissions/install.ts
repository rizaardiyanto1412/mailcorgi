import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'install.settings.get': { role: 'installAdmin' },
  'install.settings.set': { role: 'installAdmin' },
  'install.email.test': { role: 'installAdmin' },
} satisfies PermissionEntries
