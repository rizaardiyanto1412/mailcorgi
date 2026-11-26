import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'sequences.list': { role: 'member' },
  'sequences.get': { role: 'member' },
  'sequences.create': { role: 'admin' },
  'sequences.update': { role: 'admin' },
  'sequences.archive': { role: 'admin' },
  'sequences.addStep': { role: 'admin' },
  'sequences.updateStep': { role: 'admin' },
  'sequences.deleteStep': { role: 'admin' },
  'sequences.reorderSteps': { role: 'admin' },
} satisfies PermissionEntries
