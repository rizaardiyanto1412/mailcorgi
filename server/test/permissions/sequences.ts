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
  'sequences.activate': { role: 'admin', error: 'review_failed' },
  'sequences.pause': { role: 'admin', error: 'invalid_transition' },
  'sequences.resume': { role: 'admin', error: 'invalid_transition' },
  'sequences.enroll': { role: 'admin', error: 'sequence_not_active' },
  'sequences.exit': { role: 'admin', error: 'not_enrolled' },
  'sequences.pauseEnrollment': { role: 'admin', error: 'not_enrolled' },
  'sequences.resumeEnrollment': { role: 'admin', error: 'not_enrolled' },
  'sequences.listEnrollments': { role: 'member' },
  'sequences.stats': { role: 'member' },
} satisfies PermissionEntries
