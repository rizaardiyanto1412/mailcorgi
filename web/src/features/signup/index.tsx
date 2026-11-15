import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const signupFeature: Feature = {
  name: 'signup',
  settings: [{ to: '/settings/forms', label: 'Signup forms' }],
  settingsRoutes: [{ path: 'forms', element: <StubPage title="Signup forms" body="A hosted form page, an embed script and a JSON endpoint for your site." /> }],
}
