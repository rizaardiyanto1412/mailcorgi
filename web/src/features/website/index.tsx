import { Globe } from 'lucide-react'
import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const websiteFeature: Feature = {
  name: 'website',
  nav: [{ to: '/website', label: 'Website', icon: Globe }],
  routes: [{ path: 'website', element: <StubPage title="Website" body="Your public archive, RSS feed and custom domain." icon={<Globe />} /> }],
}
