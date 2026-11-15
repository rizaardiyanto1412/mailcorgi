import { useState } from 'react'
import { useParams } from 'react-router-dom'
import type { ActionOutput } from '../../../../server/registry.ts'
import { callAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { BackLink, Banner, Button, Card, EmptyState, PageHeader, Select, Skeleton, StatusBadge, statusLabel, Table } from '../../ui/index.tsx'
import { Chart } from '../overview/Charts.tsx'

const statuses = ['all', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'skipped', 'unknown', 'opened', 'clicked', 'unsubscribed'] as const
export function CampaignReport() {
  const { id = '' } = useParams()
  const { account } = useSession()
  const [status, setStatus] = useState<typeof statuses[number]>('all')
  const [after, setAfter] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const report = useActionQuery('stats.report', { campaignId: id }, { refetchInterval: (query) => (query.state.data && query.state.data.updatedAt === null ? 3_000 : 30_000) })
  const recipients = useActionQuery('stats.recipients', { campaignId: id, status, after, limit: 50 })
  const data = report.data
  useDocumentTitle(data?.campaign.subject ? `${data.campaign.subject} report` : 'Campaign report')
  const canExport = account?.owner || account?.grants[data?.campaign.newsletterId ?? ''] === 'admin'
  async function download() {
    setExporting(true)
    setError('')
    try {
      let cursor: number | null = 0
      const parts: string[] = []
      do {
        const page: ActionOutput<'stats.exportRecipients'> = await callAction('stats.exportRecipients', { campaignId: id, status, after: cursor, limit: 500 })
        parts.push(cursor ? page.csv.slice(page.csv.indexOf('\r\n') + 2) : page.csv)
        cursor = page.next
      } while (cursor !== null)
      const url = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `campaign-${id}-recipients.csv`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (err) { setError(err instanceof Error ? err.message : 'Export failed. Try again.') } finally { setExporting(false) }
  }
  return <div className="flex flex-col gap-5">
    <BackLink to={`/campaigns/${id}`}>Back to the issue</BackLink>
    <PageHeader title={data?.campaign.subject || 'Campaign report'} description={data ? <span className="inline-flex items-center gap-2"><StatusBadge status={data.campaign.status} />Delivery and engagement for this issue.</span> : 'Delivery and engagement for this issue.'} />
    {(report.error || error) && <Banner kind="danger">{report.error?.message || error}</Banner>}
    {report.isPending && <Skeleton className="h-48" />}
    {data && <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{[['Sent', data.counts.sent], ['Delivered', data.counts.delivered], ['Unique opens', data.counts.opens], ['Unique clicks', data.counts.clicks], ['Open rate', `${data.counts.openRate.toFixed(1)}%`], ['Click rate', `${data.counts.clickRate.toFixed(1)}%`], ['Click-to-open', `${data.counts.clickToOpen.toFixed(1)}%`], ['Bounces', data.counts.bounces], ['Complaints', data.counts.complaints], ['Unsubscribes', data.counts.unsubscribes]].map(([label, value]) => <Card key={label} className="p-4"><p className="text-xs text-fg-3">{label}</p><p className="mt-1 text-xl font-semibold">{value.toLocaleString()}</p></Card>)}</div>
      <Card className="p-4"><h2 className="font-medium">First 48 hours</h2><p className="mb-4 text-xs text-fg-3">{data.updatedAt === null ? 'Breakdowns are being prepared.' : `Updated ${new Date(data.updatedAt).toLocaleString()}`}</p><div className="grid gap-4 lg:grid-cols-2">{['sent', 'delivered', 'opens', 'clicks', 'bounces', 'complaints', 'unsubscribes'].map((key) => <div key={key}><h3 className="text-sm capitalize">{key}</h3><Chart label={`${key} in the first 48 hours`} kind="bar" points={data.timeline.map((p) => ({ label: `Hour ${p.hour}`, value: key === 'sent' ? p.sent : key === 'delivered' ? p.delivered : key === 'opens' ? p.opens : key === 'clicks' ? p.clicks : key === 'bounces' ? p.bounces : key === 'complaints' ? p.complaints : p.unsubscribes }))} /></div>)}</div></Card>
      <Card className="p-4"><h2 className="mb-3 font-medium">Links</h2>{data.links.length ? <Table head={<tr><th>URL</th><th>Unique clicks</th><th>Total clicks</th></tr>}>{data.links.map((link) => <tr key={link.id}><td className="max-w-64 truncate" title={link.url}>{link.url}</td><td>{link.unique_clicks}</td><td>{link.clicks}</td></tr>)}</Table> : <EmptyState title="No tracked links" body="Add links to your next campaign to see click results here." />}</Card>
      <Card className="p-4"><h2 className="mb-3 font-medium">Inbox providers</h2>{data.providers.length ? <Table head={<tr><th>Provider</th><th>Sent</th><th>Delivered</th><th>Open rate</th><th>Click rate</th><th>Bounces</th></tr>}>{data.providers.map((p) => <tr key={p.provider}><td>{p.provider}</td><td>{p.sent}</td><td>{p.delivered}</td><td>{p.openRate.toFixed(1)}%</td><td>{p.clickRate.toFixed(1)}%</td><td>{p.bounces}</td></tr>)}</Table> : <EmptyState title="No provider breakdown yet" body="Breakdowns appear after sending and refresh within five minutes." />}</Card>
    </>}
    <Card className="p-4"><div className="mb-4 flex flex-wrap items-center gap-3"><h2 className="mr-auto font-medium">Recipients</h2><Select aria-label="Recipient status" className="!w-48" value={status} onChange={(e) => { const value = statuses.find((s) => s === e.target.value); if (value) { setStatus(value); setAfter(0) } }}>{statuses.map((s) => <option key={s} value={s}>{s === 'all' ? 'All recipients' : statusLabel(s)}</option>)}</Select>{canExport && <Button loading={exporting} onClick={() => void download()}>Export CSV</Button>}</div>
      {recipients.error && <Banner kind="danger">{recipients.error.message}</Banner>}
      {recipients.isPending ? <Skeleton className="h-32" /> : recipients.data?.items.length ? <Table head={<tr><th>Email</th><th>Status</th><th>Opened</th><th>Clicked</th></tr>}>{recipients.data.items.map((r) => <tr key={r.id}><td>{r.email}</td><td><StatusBadge status={r.status} /></td><td>{r.opened_at === null ? '—' : new Date(r.opened_at).toLocaleString()}</td><td>{r.clicked_at === null ? '—' : new Date(r.clicked_at).toLocaleString()}</td></tr>)}</Table> : <EmptyState title="No recipients match" body="Send the campaign or choose a different status filter." />}
      <div className="mt-3 flex gap-2">{after > 0 && <Button onClick={() => setAfter(0)}>First page</Button>}{recipients.data?.next != null && <Button onClick={() => setAfter(recipients.data?.next ?? 0)}>Next page</Button>}</div>
    </Card>
  </div>
}
