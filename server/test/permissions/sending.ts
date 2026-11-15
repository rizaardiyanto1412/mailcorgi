import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'campaigns.send': { role: 'admin', error: 'review_failed' },
  'campaigns.schedule': { role: 'admin', input: { scheduledAt: Date.UTC(2026, 0, 16) }, error: 'review_failed' },
  'campaigns.cancel': { role: 'admin' },
  'campaigns.pause': { role: 'admin', error: 'invalid_transition' },
  'campaigns.resume': { role: 'admin', error: 'invalid_transition' },
  'campaigns.sendMore': { role: 'admin', error: 'invalid_transition' },
  'campaigns.sendTest': { role: 'member', input: { to: ['test@example.com'] }, error: 'sender_unverified' },
  'campaigns.audienceCount': { role: 'member' },
  'campaigns.progress': { role: 'member' },
} satisfies PermissionEntries
