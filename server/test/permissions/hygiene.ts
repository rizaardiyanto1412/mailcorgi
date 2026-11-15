import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'hygiene.settings': { role: 'admin' },
  'hygiene.updateSettings': { role: 'admin' },
  'hygiene.health': { role: 'member' },
  'hygiene.resume': { role: 'owner', input: { confirmation: 'RESUME' } },
} satisfies PermissionEntries
