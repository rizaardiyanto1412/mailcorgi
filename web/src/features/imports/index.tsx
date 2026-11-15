import { Upload } from 'lucide-react'
import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const importsFeature: Feature = {
  name: 'imports',
  nav: [{ to: '/imports', label: 'Imports', icon: Upload }],
  routes: [{ path: 'imports', element: <StubPage title="Imports" body="Upload a CSV from beehiiv, Substack, Mailchimp and others. Bad rows are cleaned and reported." icon={<Upload />} /> }],
}
