import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'team.list': { role: 'owner' },
  'team.invite': { role: 'owner' },
  'team.resend': { role: 'owner' },
  'team.revoke': { role: 'owner' },
  'team.changeRole': { role: 'owner' },
  'team.remove': { role: 'owner' },
  'team.leave': { role: 'teammate' },
  'team.accept': { role: 'user' },
  'team.newsletters': { role: 'user' },
} satisfies PermissionEntries
