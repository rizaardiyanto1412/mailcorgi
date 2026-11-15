import { Send } from 'lucide-react'
import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const campaignsFeature: Feature = {
  name: 'campaigns',
  nav: [{ to: '/campaigns', label: 'Campaigns', icon: Send }],
  routes: [
    { path: 'campaigns', element: <StubPage title="Campaigns" body="Write an issue, review it and send it to your list." icon={<Send />} /> },
    { path: 'campaigns/:id', element: <StubPage title="Campaign" body="Write, review and send one issue." icon={<Send />} /> },
  ],
}
