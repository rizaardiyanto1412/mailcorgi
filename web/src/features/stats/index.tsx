import { Link } from 'react-router-dom'
import { ChartNoAxesColumn, LayoutDashboard } from 'lucide-react'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Card, EmptyState, PageHeader, StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

function Overview() {
  useDocumentTitle('Overview')
  const { current, boot } = useSession()
  const tiles = [
    { label: 'Subscribers', value: '0', hint: 'Import a list or share your signup form.' },
    { label: 'Issues sent', value: '0', hint: 'Write your first issue under Campaigns.' },
    { label: 'Site views', value: '0', hint: current ? `${boot.appUrl}/n/${current.slug}` : '' },
  ]
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={current?.name ?? 'Overview'} description={current?.description || 'Your newsletter at a glance.'} />
      <div className="grid gap-4 sm:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs font-medium text-fg-3">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{t.value}</p>
            <p className="mt-1 truncate text-[13px] text-fg-3">{t.hint}</p>
          </Card>
        ))}
      </div>
      <Card>
        <EmptyState
          icon={<ChartNoAxesColumn />}
          title="Nothing to report yet"
          body="Growth, opens and clicks show up here once you have subscribers and send an issue."
          action={
            <Link to="/campaigns" className="text-sm font-medium text-accent-fg underline">
              Go to campaigns
            </Link>
          }
        />
      </Card>
    </div>
  )
}

export const statsFeature: Feature = {
  name: 'stats',
  nav: [{ to: '/', label: 'Overview', icon: LayoutDashboard }],
  routes: [
    { index: true, element: <Overview /> },
    { path: 'campaigns/:id/report', element: <StubPage title="Campaign report" body="Sent, delivered, opens, clicks, bounces and the link table for one issue." icon={<ChartNoAxesColumn />} /> },
  ],
}
