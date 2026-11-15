import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const apikeysFeature: Feature = {
  name: 'apikeys',
  settings: [{ to: '/settings/api', label: 'API & MCP' }],
  settingsRoutes: [{ path: 'api', element: <StubPage title="API & MCP" body="Create keys for the REST API and the MCP server." /> }],
}
