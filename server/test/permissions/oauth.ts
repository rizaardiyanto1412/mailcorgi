import type { PermissionEntries } from '../permission-types.ts'

const request = { origin: 'https://not-an-app-host.example', client_id: 'mcl_example' }

export const entries = {
  'oauth.listApps': { role: 'owner' },
  'oauth.revokeApp': { role: 'owner', input: { grantId: 'oag_example' } },
  // Any signed-in user may see a consent screen; only an account owner can approve (checked in oauth.test.ts).
  'oauth.describe': { role: 'user', error: 'invalid_request', input: request },
  'oauth.decide': { role: 'user', error: 'invalid_request', input: { ...request, approve: true } },
} satisfies PermissionEntries
