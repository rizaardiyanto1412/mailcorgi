import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'website.get': { role: 'admin' },
  'website.update': { role: 'admin', input: { settings: {} } },
  'website.setHost': { role: 'admin', input: { hostname: '' } },
  'website.checkHost': { role: 'admin' },
  'website.updateIssue': { role: 'admin', input: { visible: true } },
  'website.publishPost': { role: 'member', input: { subject: 'Web draft', source: 'Draft content', visible: false } },
  'website.stats': { role: 'admin' },
} satisfies PermissionEntries
