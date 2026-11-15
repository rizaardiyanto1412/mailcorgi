import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const domainsFeature: Feature = {
  name: 'domains',
  settings: [{ to: '/settings/domains', label: 'Sending domains' }],
  settingsRoutes: [{ path: 'domains', element: <StubPage title="Sending domains" body="Add a domain, add its DNS records and send from your own address." /> }],
}
