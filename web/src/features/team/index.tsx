import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const teamFeature: Feature = {
  name: 'team',
  settings: [{ to: '/settings/team', label: 'Team' }],
  settingsRoutes: [{ path: 'team', element: <StubPage title="Team" body="Invite people to write, edit and send this newsletter." /> }],
}
