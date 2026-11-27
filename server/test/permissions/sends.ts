import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'sends.list': { role: 'member' },
  'sends.detail': { role: 'member', error: 'not_found', input: { deliveryId: '1' } },
} satisfies PermissionEntries
