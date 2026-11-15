import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'billing.get': { role: 'owner' },
  'billing.checkout': { role: 'owner' },
  'billing.portal': { role: 'owner' },
  'billing.changePlan': { role: 'owner' },
  'billing.cancel': { role: 'owner' },
} satisfies PermissionEntries
