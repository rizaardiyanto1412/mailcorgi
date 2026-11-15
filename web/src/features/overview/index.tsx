import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Card, EmptyState, LinkButton, PageHeader, Select, Skeleton, sourceLabel, Table } from '../../ui/index.tsx'
import { Chart } from './Charts.tsx'

const ranges = ['7', '30', '90', 'all'] as const
export function Overview() {
  useDocumentTitle('Overview')
  const { current } = useSession()
  const [range, setRange] = useState<typeof ranges[number]>('30')
  const query = useActionQuery('stats.overview', { newsletterId: current?.id ?? '', range }, { enabled: !!current, refetchInterval: 60_000 })
  if (!current) return <EmptyState title="Create your newsletter" body="Create a newsletter to see subscriber growth and campaign results." />
  const data = query.data
  return <div className="flex flex-col gap-6">
    <PageHeader title={current.name} description="Your newsletter at a glance." action={<Select aria-label="Stats period" className="!w-40" value={range} onChange={(e) => { const value = ranges.find((r) => r === e.target.value); if (value) setRange(value) }}>{ranges.map((r) => <option value={r} key={r}>{r === 'all' ? 'All time' : `Last ${r} days`}</option>)}</Select>} />
    {query.error && <Banner kind="danger">{query.error.message}</Banner>}
    {!data && query.isPending && <Skeleton className="h-48" />}
    {data && <>
      <div className="grid gap-4 sm:grid-cols-3">{[['Subscribers', data.subscribers], ['Net new subscribers', data.netNew], ['Website views', data.pageViews]].map(([label, value]) => <Card key={label} className="p-4"><p className="text-xs text-fg-3">{label}</p><p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p></Card>)}</div>
      <Card className="p-4"><h2 className="mb-3 font-medium">Subscriber growth</h2><Chart label="Subscribed contacts over time" points={data.growth.map((p) => ({ label: p.day, value: p.subscribers }))} /></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4"><h2 className="mb-3 font-medium">Growth by source</h2>{data.sources.length ? <Table head={<tr><th>Source</th><th>Added</th><th>Removed</th><th>Net new</th></tr>}>{data.sources.map((s) => <tr key={s.source}><td>{sourceLabel(s.source)}</td><td>{s.added.toLocaleString()}</td><td>{s.removed.toLocaleString()}</td><td>{s.net.toLocaleString()}</td></tr>)}</Table> : <EmptyState title="No subscriber activity" body="Import contacts or share your signup form." />}</Card>
        <Card className="p-4"><h2 className="mb-3 font-medium">Website views</h2><Chart label="Daily website page views" kind="bar" points={data.growth.map((p) => ({ label: p.day, value: p.pageViews }))} /></Card>
      </div>
      <Card className="p-4"><h2 className="mb-3 font-medium">Recent campaigns</h2>{data.campaigns.length ? <Table head={<tr><th>Campaign</th><th>Sent</th><th>Open rate</th><th>Click rate</th></tr>}>{data.campaigns.map((c) => <tr key={c.id}><td><Link to={`/campaigns/${c.id}/report`} className="font-medium hover:underline">{c.subject || 'Untitled issue'}</Link></td><td>{c.counts.sent.toLocaleString()}</td><td>{c.counts.openRate.toFixed(1)}%</td><td>{c.counts.clickRate.toFixed(1)}%</td></tr>)}</Table> : <EmptyState title="No campaigns yet" body="Send your first issue to see opens and clicks." action={<LinkButton to="/campaigns" variant="primary">Write an issue</LinkButton>} />}</Card>
      {!(data.checklist.domain && data.checklist.imported && data.checklist.campaign) && <Card className="p-4"><h2 className="mb-3 font-medium">Getting started</h2><ul className="space-y-2 text-sm">{[{ done: data.checklist.domain, to: '/settings/domains', title: 'Verify your sending domain' }, { done: data.checklist.imported, to: '/imports', title: 'Import your first contacts' }, { done: data.checklist.campaign, to: '/campaigns', title: 'Send your first campaign' }].map((item) => <li key={item.to}><span aria-label={item.done ? 'Complete' : 'Incomplete'}>{item.done ? '✓' : '○'}</span> <Link to={item.to} className="text-accent-fg underline">{item.title}</Link></li>)}</ul></Card>}
      <div className="grid gap-4 lg:grid-cols-3">{['path', 'referrer', 'country'].map((dimension) => <Card className="p-4" key={dimension}><h2 className="mb-3 font-medium">{dimension === 'path' ? 'Popular pages' : dimension === 'referrer' ? 'Referrers' : 'Countries'}</h2>{data.website.some((r) => r.dimension === dimension) ? <Table head={<tr><th>{dimension === 'path' ? 'Page' : dimension === 'referrer' ? 'Referrer' : 'Country'}</th><th>Views</th></tr>}>{data.website.filter((r) => r.dimension === dimension).slice(0, 10).map((r) => <tr key={r.value}><td className="max-w-48 truncate" title={r.value}>{r.value || (dimension === 'referrer' ? 'Direct' : 'Unknown')}</td><td>{r.views}</td></tr>)}</Table> : <p className="text-sm text-fg-3">No views yet. Publish an issue and share your website.</p>}</Card>)}</div>
      <p className="text-xs text-fg-3">Website traffic breakdowns refresh within five minutes. Subscriber history reflects recorded subscription events.</p>
    </>}
  </div>
}
