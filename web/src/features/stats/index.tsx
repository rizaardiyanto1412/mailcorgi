import { LayoutDashboard } from 'lucide-react'
import type { Feature } from '../../app/feature.ts'
import { Overview } from '../overview/index.tsx'
import { CampaignReport } from '../reports/index.tsx'

export const statsFeature: Feature = {
  name: 'stats',
  nav: [{ to: '/', label: 'Overview', icon: LayoutDashboard }],
  routes: [{ index: true, element: <Overview /> }, { path: 'campaigns/:id/report', element: <CampaignReport /> }],
}
