import { Filter } from 'lucide-react'
import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const segmentsFeature: Feature = {
  name: 'segments',
  nav: [{ to: '/segments', label: 'Segments', icon: Filter }],
  routes: [{ path: 'segments', element: <StubPage title="Segments" body="Saved filters over your contacts: status, tags, fields and engagement." icon={<Filter />} /> }],
}
