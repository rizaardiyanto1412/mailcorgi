import { ShieldCheck } from 'lucide-react'
import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const adminFeature: Feature = {
  name: 'admin',
  routes: [{ path: 'admin/*', element: <StubPage title="Admin console" body="Install settings, email provider, accounts, alerts and dead jobs." icon={<ShieldCheck />} /> }],
}
