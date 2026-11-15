import { useState } from 'react'
import { EmailSettingsPage } from './email.tsx'
import { NavLink, Navigate, Outlet } from 'react-router-dom'
import type { Feature } from '../../app/feature.ts'
import { useSession } from '../../lib/session.tsx'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { Badge, Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Textarea, useFeedback } from '../../ui/index.tsx'

function AdminLayout() {
  const { session } = useSession()
  if (!session.user.isInstallAdmin) return <EmptyState title="Install admins only" body="Ask the person who runs this install for help." />
  return <div className="flex flex-col gap-5"><PageHeader title="Admin console" /><nav className="flex flex-wrap gap-2" aria-label="Admin console">{['accounts', 'alerts', 'jobs', 'settings', 'email', 'suppressions'].map((name) => <NavLink className={({ isActive }) => `rounded-lg px-3 py-2 text-sm capitalize ${isActive ? 'bg-accent-soft text-accent-fg' : 'text-fg-2 hover:bg-hover'}`} key={name} to={`/admin/${name}`}>{name === 'jobs' ? 'Dead jobs' : name === 'email' ? 'Email' : name}</NavLink>)}</nav><Outlet /></div>
}
function AccountsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'blocked' | 'deleting'>('all')
  const [plan, setPlan] = useState('')
  const [offset, setOffset] = useState(0)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')
  const query = useActionQuery('admin.accounts', { search, status, plan, offset })
  const { confirm } = useFeedback()
  const block = useAction('admin.block', { invalidate: ['admin.accounts'] })
  const unblock = useAction('admin.unblock', { invalidate: ['admin.accounts'] })
  const remove = useAction('admin.deleteAccount', { invalidate: ['admin.accounts'] })
  const summary = useAction('admin.accountSummary', { onSuccess: (data) => setNotice(`${data.name}: ${data.summary.newsletters} newsletters, ${data.summary.contacts} subscribed contacts.`) })
  const error = query.error || block.error || unblock.error || remove.error || summary.error
  return <div className="flex flex-col gap-4"><PageHeader title="Accounts" description="Read account summaries without impersonation." />
    {error && <Banner kind="danger">{error.message}</Banner>}{notice && <Banner>{notice}</Banner>}
    <div className="grid gap-3 sm:grid-cols-3"><Field label="Search accounts">{(id) => <Input id={id} value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} placeholder="Name or owner email" />}</Field><Field label="Status">{(id) => <Select id={id} value={status} onChange={(e) => { const v = e.target.value; setStatus(v === 'active' || v === 'blocked' || v === 'deleting' ? v : 'all'); setOffset(0) }}><option value="all">All statuses</option>{['active', 'blocked', 'deleting'].map((s) => <option key={s}>{s}</option>)}</Select>}</Field><Field label="Plan">{(id) => <Select id={id} value={plan} onChange={(e) => { setPlan(e.target.value); setOffset(0) }}><option value="">All plans</option>{['free', 'starter', 'growth', 'pro', 'scale', 'selfhosted'].map((s) => <option key={s}>{s}</option>)}</Select>}</Field></div>
    <Field label="Block reason" hint="Required before blocking an account.">{(id) => <Input id={id} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />}</Field>
    {query.isPending && <Spinner />}
    {query.data?.length === 0 && <Card><EmptyState title="No accounts found" body="Clear the filters, or wait for someone to sign up." /></Card>}
    {!!query.data?.length && <Table head={<tr><th>Account</th><th>Plan and usage</th><th>Status</th><th>Actions</th></tr>}>{query.data.map((a) => <tr key={a.id}><td><p>{a.name}</p><p className="text-xs text-fg-3">{a.email}</p></td><td><p className="capitalize">{a.plan}</p><p className="text-xs text-fg-3">{a.contacts.toLocaleString()} contacts · {a.emails_sent.toLocaleString()} emails</p></td><td><Badge tone={a.status === 'blocked' ? 'danger' : 'neutral'}>{a.status}</Badge>{a.block_reason && <p className="mt-1 max-w-xs break-words text-xs">{a.block_reason}</p>}</td><td><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => summary.mutate({ accountId: a.id })}>Summary</Button>{a.status === 'blocked' ? <Button size="sm" loading={unblock.isPending} onClick={() => unblock.mutate({ accountId: a.id })}>Unblock</Button> : a.status === 'active' ? <Button size="sm" disabled={!reason.trim()} loading={block.isPending} onClick={() => block.mutate({ accountId: a.id, reason })}>Block</Button> : null}<Button size="sm" variant="danger" loading={remove.isPending} onClick={async () => { if (await confirm({ title: `Delete ${a.name}?`, body: 'All account data and images will be permanently removed.', confirmLabel: 'Delete permanently', danger: true })) remove.mutate({ accountId: a.id, confirmation: 'DELETE' }) }}>Delete</Button></div></td></tr>)}</Table>}
    <div className="flex justify-between"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><Button disabled={(query.data?.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>Next</Button></div>
  </div>
}
function AlertsPage() {
  const [resolved, setResolved] = useState(false)
  const query = useActionQuery('admin.alerts', { resolved })
  const resolve = useAction('admin.resolveAlert', { invalidate: ['admin.alerts'] })
  return <div className="flex flex-col gap-4"><PageHeader title="Alerts" action={<Button onClick={() => setResolved(!resolved)}>{resolved ? 'Show open alerts' : 'Show resolved alerts'}</Button>} />{(query.error || resolve.error) && <Banner kind="danger">{(query.error || resolve.error)?.message}</Banner>}{query.isPending && <Spinner />}{query.data?.length === 0 && <Card><EmptyState title="No alerts" body="Provider and job failures appear here when they need attention." /></Card>}{query.data?.map((a) => <Card key={a.id} className="flex flex-col gap-2 p-4"><h2 className="font-semibold">{a.title}</h2><p className="whitespace-pre-wrap break-words text-sm text-fg-2">{a.body}</p><p className="text-xs text-fg-3">{a.kind} · {new Date(a.created_at).toLocaleString()}</p>{!resolved && <Button loading={resolve.isPending} onClick={() => resolve.mutate({ alertId: a.id })}>Resolve</Button>}</Card>)}</div>
}
function JobsPage() {
  const [accountId, setAccountId] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const query = useActionQuery('admin.deadJobs', { accountId: selected, operation: 'list' })
  const mutate = useAction('admin.deadJobs', { invalidate: ['admin.deadJobs'] })
  return <div className="flex flex-col gap-4"><PageHeader title="Dead jobs" description="Inspect the control store or choose an account store." /><form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setSelected(accountId.trim() || null) }}><Field label="Account id" hint="Leave blank for the control store.">{(id) => <Input id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)} />}</Field><Button type="submit">Load store</Button></form>{(query.error || mutate.error) && <Banner kind="danger">{(query.error || mutate.error)?.message}</Banner>}{query.isPending && <Spinner />}{query.data?.length === 0 && <Card><EmptyState title="No dead jobs" body="Jobs that exhaust their retries appear here." /></Card>}{query.data?.map((j) => <Card key={j.id} className="flex flex-col gap-3 p-4"><h2 className="font-semibold">{j.kind}</h2><p className="break-words text-sm text-fg-2">{j.last_error}</p><p className="text-xs text-fg-3">{j.attempts} attempts · {new Date(j.died_at).toLocaleString()}</p><div className="flex gap-2"><Button loading={mutate.isPending} onClick={() => mutate.mutate({ accountId: selected, operation: 'retry', jobId: j.id })}>Retry</Button><Button variant="danger" loading={mutate.isPending} onClick={() => mutate.mutate({ accountId: selected, operation: 'discard', jobId: j.id })}>Discard</Button></div></Card>)}</div>
}
const keyOptions = ['signup_mode', 'allowed_emails', 'stripe_secret_key', 'stripe_webhook_secret', 'polar_access_token', 'polar_webhook_secret', 'polar_products'] as const
function SettingsPage() {
  const query = useActionQuery('admin.settings', {})
  const [key, setKey] = useState<typeof keyOptions[number]>('signup_mode')
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const save = useAction('admin.setSetting', { invalidate: ['admin.settings'], onSuccess: () => { setSaved(true); setValue('') } })
  const secret = /(secret|token)/.test(key)
  return <div className="flex flex-col gap-4"><PageHeader title="Install settings" description="Environment values take precedence. Blank secret values clear stored credentials." />{(query.error || save.error) && <Banner kind="danger">{(query.error || save.error)?.message}</Banner>}{saved && <Banner kind="ok">Setting saved.</Banner>}
    <p className="text-sm text-fg-2">Billing provider: {query.data?.billingProvider || 'Not configured'} · Mode: {query.data?.cloud ? 'Cloud' : 'Self-hosted'}</p>
    <Card className="p-5"><form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate({ key, value }) }}><Field label="Setting">{(id) => <Select id={id} value={key} onChange={(e) => { const next = keyOptions.find((k) => k === e.target.value); if (next) { setKey(next); setValue(''); setSaved(false) } }}>{keyOptions.map((k) => <option key={k} value={k}>{k.replaceAll('_', ' ')}</option>)}</Select>}</Field>
      {query.data?.fromEnv[key] && <Banner kind="warn">This setting is overridden by the environment.</Banner>}
      {secret && <p className="text-sm text-fg-3">{query.data?.secretsSet[key] ? 'A credential is stored.' : 'No credential is stored.'}</p>}
      <Field label="New value" hint={key === 'signup_mode' ? 'open, closed or allowlist. Open applies to cloud mode; self-hosted uses the allowlist.' : key === 'allowed_emails' ? 'Comma-separated email addresses.' : key === 'polar_products' ? 'JSON mapping starter_monthly, starter_yearly and other paid plan intervals to Polar product UUIDs.' : undefined}>{(id) => secret ? <Input id={id} type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} /> : <Textarea id={id} value={value} placeholder={query.data?.values[key] || ''} onChange={(e) => setValue(e.target.value)} />}</Field><Button type="submit" loading={save.isPending} disabled={query.data?.fromEnv[key]}>Save setting</Button></form></Card>
  </div>
}
function SuppressionsPage() {
  const [email, setEmail] = useState('')
  const [lookup, setLookup] = useState<string | undefined>()
  const [offset, setOffset] = useState(0)
  const query = useActionQuery('admin.suppressions', { email: lookup, offset })
  return <div className="flex flex-col gap-4"><PageHeader title="Global suppressions" description="Only keyed email hashes are stored. Nonexistent mailbox reports expire after 180 days." /><form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setLookup(email.trim() || undefined); setOffset(0) }}><Field label="Look up an email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field><Button type="submit">Look up</Button><Button onClick={() => { setEmail(''); setLookup(undefined); setOffset(0) }}>Show all</Button></form>{query.error && <Banner kind="danger">{query.error.message}</Banner>}{query.isPending && <Spinner />}{query.data?.length === 0 && <Card><EmptyState title="No suppressions found" body="Permanent nonexistent mailbox reports appear here automatically." /></Card>}{!!query.data?.length && <Table head={<tr><th>Email hash</th><th>Reason</th><th>Expires</th></tr>}>{query.data.map((s) => <tr key={s.email_hash}><td className="max-w-48 break-all font-mono text-xs">{s.email_hash}</td><td>{s.reason.replaceAll('_', ' ')}</td><td>{s.until ? new Date(s.until).toLocaleDateString() : 'Never'}</td></tr>)}</Table>}<div className="flex justify-between"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><Button disabled={(query.data?.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>Next</Button></div></div>
}
export const adminFeature: Feature = { name: 'admin', routes: [{ path: 'admin', element: <AdminLayout />, children: [{ index: true, element: <Navigate to="accounts" replace /> }, { path: 'accounts', element: <AccountsPage /> }, { path: 'alerts', element: <AlertsPage /> }, { path: 'jobs', element: <JobsPage /> }, { path: 'settings', element: <SettingsPage /> }, { path: 'email', element: <EmailSettingsPage /> }, { path: 'suppressions', element: <SuppressionsPage /> }] }] }
