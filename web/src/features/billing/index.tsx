import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const billingFeature: Feature = {
  name: 'billing',
  settings: [{ to: '/settings/billing', label: 'Billing' }],
  settingsRoutes: [{ path: 'billing', element: <StubPage title="Billing" body="Plans and invoices. Self-hosted installs have no limits and nothing to pay." /> }],
}
