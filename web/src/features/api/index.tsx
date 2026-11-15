import { BookOpen } from 'lucide-react'
import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const apiFeature: Feature = {
  name: 'api',
  routes: [{ path: 'docs/api', element: <StubPage title="API docs" body="REST and MCP reference, generated from the action registry." icon={<BookOpen />} /> }],
}
