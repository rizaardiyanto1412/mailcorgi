import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'campaigns.list': { role: 'member' },
  'campaigns.create': { role: 'member' },
  'campaigns.get': { role: 'member' },
  'campaigns.update': { role: 'member' },
  'campaigns.duplicate': { role: 'member' },
  'campaigns.delete': { role: 'member' },
  'campaigns.preview': { role: 'member' },
  'campaigns.audienceOptions': { role: 'member' },
  'campaigns.getTheme': { role: 'member' },
  'campaigns.updateTheme': { role: 'admin' },
  'campaigns.previewDesign': { role: 'member' },
  'campaigns.uploadImage': { role: 'member' },
} satisfies PermissionEntries
