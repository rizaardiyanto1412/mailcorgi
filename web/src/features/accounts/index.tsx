import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const accountsFeature: Feature = {
  name: 'accounts',
  settings: [{ to: '/settings/account', label: 'Account' }],
  settingsRoutes: [{ path: 'account', element: <StubPage title="Account" body="Your profile, password, sessions and account deletion." /> }],
}
