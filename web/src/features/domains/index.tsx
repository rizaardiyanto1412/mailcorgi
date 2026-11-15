import { useState } from 'react'
import type { Feature } from '../../app/feature.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { Badge, Banner, Button, Card, EmptyState, Field, Input, NoAccess, PageHeader, Select, Spinner, StatusBadge, useFeedback } from '../../ui/index.tsx'
import { useCanAdmin, useIsOwner } from '../../lib/session.tsx'

/** A host name that wraps after its dots, not in the middle of a label. */
const Breakable = ({ text }: { text: string }) => <>{text.split('.').map((part, i) => <span key={i}>{i > 0 && <>.<wbr /></>}{part}</span>)}</>

export function SenderDomainPicker({ newsletterId, value, onChange }: { newsletterId: string; value: string; onChange: (domainId: string) => void }) {
  const canAdmin = useCanAdmin(newsletterId)
  const query = useActionQuery('domains.senders', { newsletterId }, { enabled: canAdmin })
  if (!canAdmin) return null
  return <Field label="Sender domain" hint={query.data?.length ? 'Only verified domains can send newsletters.' : 'Add and verify a sending domain in settings.'}>{(id) => <><Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={query.isPending}><option value="">Choose a verified domain</option>{query.data?.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</Select>{query.error && <Banner kind="danger">{query.error.message}</Banner>}</>}</Field>
}

export function DomainsPage() {
  const owner = useIsOwner()
  if (!owner) return <div className="flex flex-col gap-5"><PageHeader title="Sending domains" description="Add your domain and publish its DNS records to send newsletters." /><NoAccess title="Only the owner manages sending domains" body="Sending domains belong to the whole account. Ask the owner to add or verify one." /></div>
  return <Domains />
}
function Domains() {
  const query = useActionQuery('domains.list', {})
  const [name, setName] = useState('')
  const feedback = useFeedback()
  const add = useAction('domains.add', { invalidate: ['domains.list'], onSuccess: () => setName('') })
  const check = useAction('domains.check', { invalidate: ['domains.list', 'domains.senders'] })
  const remove = useAction('domains.delete', { invalidate: ['domains.list', 'domains.senders'] })
  const error = query.error || add.error || check.error || remove.error
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); feedback.toast('Copied') } catch { feedback.toast('Select the record and copy it manually.', { kind: 'error' }) }
  }
  return <div className="flex flex-col gap-5">
    <PageHeader title="Sending domains" description="Add your domain and publish its DNS records to send newsletters." />
    {error && <Banner kind="danger">{error.message}</Banner>}
    <Card className="p-4"><form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); add.mutate({ name }) }}><Field label="Domain" className="min-w-0 flex-1">{(id) => <Input id={id} required placeholder="example.com" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}" />}</Field><Button type="submit" variant="primary" loading={add.isPending}>Add domain</Button></form></Card>
    {query.isPending && <Spinner />}
    {query.data?.length === 0 && <Card><EmptyState title="No sending domains yet" body="Add your domain above, then copy the records into your DNS settings." /></Card>}
    {query.data?.map((domain) => <Card key={domain.id} className="min-w-0 p-4"><div className="flex flex-wrap items-center gap-3"><h2 className="min-w-0 basis-full break-words font-semibold sm:basis-auto sm:flex-1"><Breakable text={domain.name} /></h2><StatusBadge status={domain.status} /><Button loading={check.isPending && check.variables?.domainId === domain.id} onClick={() => check.mutate({ domainId: domain.id })}>Check now</Button><Button variant="ghost" onClick={async () => { if (await feedback.confirm({ title: `Remove ${domain.name}?`, body: 'Newsletters using this domain will need a new sender.', confirmLabel: 'Remove domain', danger: true })) remove.mutate({ domainId: domain.id }) }}>Remove</Button></div>
      <p className="my-3 text-xs text-fg-3">{domain.lastCheckedAt ? `Last checked ${new Date(domain.lastCheckedAt).toLocaleString()}` : 'Not checked yet'}. DNS changes can take up to 48 hours.</p>
      <div className="flex flex-col divide-y divide-line">{domain.records.map((record, i) => <div key={i} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[100px_1fr_auto]"><div><Badge>{record.type}</Badge><p className="mt-1 text-xs text-fg-3">{record.purpose}{record.required ? '' : ' (suggested)'}</p></div><div className="min-w-0 text-sm"><button className="block max-w-full break-words text-left font-mono hover:text-accent-fg" title="Copy record name" onClick={() => void copy(record.name)}><Breakable text={record.name} /></button><button className="mt-1 block max-w-full break-all text-left font-mono text-fg-3 hover:text-accent-fg" title="Copy record value" onClick={() => void copy(record.value)}>{record.value}</button></div><Badge tone={record.found ? 'ok' : 'warn'} className="self-start justify-self-start">{record.found ? 'Found' : 'Missing'}</Badge></div>)}</div>
    </Card>)}
  </div>
}

export const domainsFeature: Feature = {
  name: 'domains',
  settings: [{ to: '/settings/domains', label: 'Sending domains', role: 'owner' }],
  settingsRoutes: [{ path: 'domains', element: <DomainsPage /> }],
}
