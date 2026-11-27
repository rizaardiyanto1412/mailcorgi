import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChartColumn, Copy, Ellipsis, Eye, EyeOff, Plus, Send, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { Feature } from '../../app/feature.ts'
import type { Campaign, CampaignStatus } from '../../../../server/account/campaigns/index.ts'
import { nodeSchema } from '../../../../server/account/render/doc.ts'
import { useSession, useDocumentTitle } from '../../lib/session.tsx'
import { callAction, useAction, useActionQuery, actionKey, ApiError } from '../../lib/api.ts'
import { BackLink, Banner, Button, EmptyState, IconButton, MenuItem, Popover, Field, Input, LinkButton, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Textarea, useFeedback } from '../../ui/index.tsx'
import { Preview } from './Preview.tsx'
import { SenderOverride } from './Sender.tsx'
import { AudiencePicker } from './Audience.tsx'
import { Progress, SendStep, TestSend } from './SendStep.tsx'
import { loadChunk } from '../../lib/reload.ts'

const CampaignEditor = lazy(loadChunk(() => import('./Editor.tsx').then((module) => ({ default: module.CampaignEditor }))))

function CampaignList() {
  useDocumentTitle('Campaigns')
  const { current } = useSession()
  const [status, setStatus] = useState<CampaignStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const navigate = useNavigate()
  const list = useActionQuery('campaigns.list', { newsletterId: current?.id ?? '', status: status === 'all' ? undefined : status, search, offset }, { enabled: !!current })
  const create = useAction('campaigns.create', { invalidate: ['campaigns.list'], onSuccess: (c) => navigate(`/campaigns/${c.id}`) })
  if (!current) return <EmptyState title="Choose a newsletter" body="Create your first newsletter to start writing." action={<Link to="/welcome">Create a newsletter</Link>} />
  return <div className="flex flex-col gap-5">
    <PageHeader title="Campaigns" description="Write, schedule and send issues of your newsletter." action={<Button variant="primary" icon={<Plus />} loading={create.isPending} onClick={() => create.mutate({ newsletterId: current.id })}>Write an issue</Button>} />
    {create.error && <Banner kind="danger">{create.error.message}</Banner>}
    <div className="overflow-x-auto"><Tabs value={status} onChange={(value) => {
      setStatus(value)
      setOffset(0)
    }} tabs={['all', 'draft', 'scheduled', 'sending', 'paused', 'sent', 'canceled'].map((id) => ({ id: id as CampaignStatus | 'all', label: id[0].toUpperCase() + id.slice(1) }))} /></div>
    <Input aria-label="Search campaigns" placeholder="Search subjects…" value={search} onChange={(e) => {
      setSearch(e.target.value)
      setOffset(0)
    }} />
    {list.isPending ? <Spinner /> : list.error ? <Banner kind="danger">{list.error.message}</Banner> : !list.data.campaigns.length ? <EmptyState icon={<Send />} title={search || status !== 'all' ? 'No matching campaigns' : 'Your first issue starts here'} body="Write an issue, review it, and send it to your subscribers." action={<Button onClick={() => create.mutate({ newsletterId: current.id })}>Write an issue</Button>} /> : <>
      <Table head={<tr><th>Subject</th><th>Status</th><th>Updated</th></tr>}>{list.data.campaigns.map((c) => <tr key={c.id}><td><Link className="font-medium hover:underline" to={`/campaigns/${c.id}`}>{c.subject || 'Untitled issue'}</Link></td><td><StatusBadge status={c.status} /></td><td className="whitespace-nowrap text-fg-3">{new Date(c.updatedAt).toLocaleDateString()}</td></tr>)}</Table>
      <div className="flex items-center justify-between"><span className="text-sm text-fg-3">{list.data.total} campaigns</span><div className="flex gap-2"><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</Button><Button disabled={offset + 30 >= list.data.total} onClick={() => setOffset(offset + 30)}>Next</Button></div></div>
    </>}
  </div>
}
function CampaignPage() {
  const { id = '' } = useParams()
  const [reloadVersion, setReloadVersion] = useState(0)
  const campaign = useActionQuery('campaigns.get', { campaignId: id }, { refetchOnWindowFocus: false, refetchOnReconnect: false })
  useDocumentTitle(campaign.data?.subject || 'Write an issue')
  return campaign.isPending ? <Spinner /> : campaign.error ? <Banner kind="danger">{campaign.error.message}</Banner> : <Draft key={`${id}:${reloadVersion}`} initial={campaign.data} reload={async () => {
    await campaign.refetch()
    setReloadVersion((version) => version + 1)
  }} />
}
function Draft({ initial, reload }: {
  initial: Campaign
  reload(): unknown
}) {
  const [draft, setDraft] = useState({ subject: initial.subject, previewText: initial.previewText, format: initial.format, sendFormat: initial.sendFormat, hideUnsubscribeFooter: initial.hideUnsubscribeFooter, fromDomainId: initial.fromDomainId, fromLocal: initial.fromLocal, fromName: initial.fromName, doc: initial.doc, source: initial.source, html: initial.html, text: initial.text, audience: initial.audience })
  const [revision, setRevision] = useState(initial.revision)
  const [saved, setSaved] = useState(JSON.stringify(draft))
  const [saveState, setSaveState] = useState('Saved')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [step, setStep] = useState<'write' | 'review' | 'send'>(initial.status === 'draft' ? 'write' : 'send')
  const [showPreview, setShowPreview] = useState(false)
  const saving = useRef(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { confirm } = useFeedback()
  const editable = initial.status === 'draft'
  const serialized = JSON.stringify(draft)
  const preview = useActionQuery('campaigns.preview', { campaignId: initial.id }, { enabled: showPreview || step !== 'write' })
  const refreshPreview = preview.refetch
  const save = useCallback(async () => {
    if (serialized === saved) return true
    if (!editable || saving.current || conflict) return false
    saving.current = true
    setSaveState('Saving…')
    try {
      // Only the sender fields that changed are sent: the server re-checks the sender whenever they are, and an unrelated autosave must not fail on it.
      const { fromDomainId, fromLocal, fromName, ...content } = draft
      const was: Record<string, unknown> = JSON.parse(saved)
      const sender = { ...(fromDomainId !== was.fromDomainId && { fromDomainId }), ...(fromLocal !== was.fromLocal && { fromLocal }), ...(fromName !== was.fromName && { fromName }) }
      const result = await callAction('campaigns.update', { campaignId: initial.id, revision, ...content, ...sender })
      queryClient.setQueryData(actionKey('campaigns.get', { campaignId: initial.id }), result)
      setRevision(result.revision)
      setSaved(serialized)
      setSaveState('Saved')
      setError('')
      void refreshPreview()
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save this draft.'
      setError(message)
      setSaveState('Unsaved')
      if (e instanceof ApiError && e.status === 409) setConflict(true)
      return false
    } finally { saving.current = false }
  }, [editable, conflict, serialized, saved, initial.id, revision, draft, refreshPreview, queryClient])
  useEffect(() => {
    if (!editable || serialized === saved || conflict) return
    const timer = setTimeout(() => void save(), 900)
    return () => clearTimeout(timer)
  }, [serialized, saved, conflict, editable, save])
  useEffect(() => {
    if (serialized === saved) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [serialized, saved])
  // ⌘S saves from anywhere on the page, not only while the caret is in the editor.
  useEffect(() => {
    if (!editable) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's' || e.defaultPrevented) return
      e.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editable, save])
  const [actionError, setActionError] = useState('')
  const duplicate = useAction('campaigns.duplicate', { onSuccess: (c) => navigate(`/campaigns/${c.id}`) })
  const remove = useAction('campaigns.delete', { onSuccess: () => navigate('/campaigns') })
  return <div className="flex flex-col gap-5">
    <BackLink to="/campaigns">Campaigns</BackLink>
    <PageHeader title={draft.subject || 'Untitled issue'} description={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={initial.status} /><span role="status">{editable ? (serialized !== saved && saveState === 'Saved' ? 'Unsaved changes' : saveState) : initial.status === 'sent' ? 'Sent to your audience.' : 'This issue can no longer be edited.'}</span></span>} action={<div className="flex items-center gap-2">{initial.status === 'sent' && <LinkButton to={`/campaigns/${initial.id}/report`} icon={<ChartColumn />}>View report</LinkButton>}{editable && step === 'write' && <Button icon={showPreview ? <EyeOff /> : <Eye />} onClick={() => {
      setShowPreview(!showPreview)
      void preview.refetch()
    }}>{showPreview ? 'Hide preview' : 'Preview'}</Button>}{editable && <Button variant={serialized === saved ? 'secondary' : 'primary'} disabled={serialized === saved} onClick={() => void save()}>Save</Button>}<Popover align="end" width={200} trigger={({ ref, ...props }) => <IconButton ref={ref} {...props} label="More actions" className="border border-line-strong"><Ellipsis /></IconButton>}>{(close) => <>
      <MenuItem icon={<Copy />} onSelect={async () => {
        close()
        try {
          if (!await save()) return
          duplicate.mutate({ campaignId: initial.id })
        } catch (e) { setActionError(e instanceof Error ? e.message : 'Could not duplicate.') }
      }}>Duplicate</MenuItem>
      {editable && <MenuItem danger icon={<Trash2 />} onSelect={async () => {
        close()
        if (await confirm({ title: 'Delete this draft?', body: 'This cannot be undone.', confirmLabel: 'Delete draft', danger: true })) remove.mutate({ campaignId: initial.id, revision })
      }}>Delete draft</MenuItem>}
    </>}</Popover></div>} />
    <Tabs value={step} onChange={(value) => {
      setStep(value)
      if (serialized !== saved) void save()
      else void preview.refetch()
    }} tabs={[{ id: 'write', label: '1 · Write' }, { id: 'review', label: '2 · Review' }, { id: 'send', label: '3 · Send' }]} />
    {error && <Banner kind="danger" action={conflict ? <Button size="sm" onClick={async () => { if (await confirm({ title: 'Load the newer draft?', body: 'Your unsaved changes will be replaced.', confirmLabel: 'Load newer draft' })) reload() }}>Load newer draft</Button> : <Button size="sm" onClick={() => void save()}>Retry</Button>}>{error}</Banner>}
    {(actionError || duplicate.error || remove.error) && <Banner kind="danger">{actionError || duplicate.error?.message || remove.error?.message}</Banner>}
    {step === 'write' ? <>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Subject">{(id) => <Input id={id} disabled={!editable} maxLength={500} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Give your issue a subject" />}</Field><Field label="Preview text">{(id) => <Input id={id} disabled={!editable} maxLength={1000} value={draft.previewText} onChange={(e) => setDraft({ ...draft, previewText: e.target.value })} placeholder="A little more reason to open" />}</Field></div>
      <div className="flex flex-wrap items-center gap-3"><Select aria-label="Content format" disabled={!editable} className="!w-44" value={draft.format} onChange={(e) => {
        const format = e.target.value
        if (format === 'doc' || format === 'markdown' || format === 'html') setDraft({ ...draft, format })
      }}><option value="doc">Visual editor</option><option value="markdown">Markdown</option><option value="html">HTML</option></Select><label className="flex items-center gap-2 text-sm" title="No design, footer or tracking: it reads like an email you wrote by hand. An unsubscribe line is added at the end."><input type="checkbox" disabled={!editable} checked={draft.sendFormat === 'plain'} onChange={(e) => setDraft({ ...draft, sendFormat: e.target.checked ? 'plain' : 'html' })} />Send as plain text</label>{draft.sendFormat === 'plain' && initial.kind !== 'welcome' && <label className="flex items-center gap-2 text-sm" title="Leaves out the closing unsubscribe line. Readers can still unsubscribe from their mail app: the List-Unsubscribe headers are always sent."><input type="checkbox" disabled={!editable} checked={draft.hideUnsubscribeFooter} onChange={(e) => setDraft({ ...draft, hideUnsubscribeFooter: e.target.checked })} />Hide the unsubscribe line</label>}{!editable && <Button onClick={() => {
        setShowPreview(!showPreview)
        void preview.refetch()
      }}>{showPreview ? 'Hide preview' : 'Show preview'}</Button>}</div>
      <SenderOverride newsletterId={initial.newsletterId} value={draft} disabled={!editable} onChange={(next) => setDraft({ ...draft, ...next })} />
      <div className={showPreview ? 'grid items-start gap-5 lg:grid-cols-2' : ''}><div className="space-y-5">
        {draft.format === 'doc' ? <Suspense fallback={<Spinner />}><CampaignEditor newsletterId={initial.newsletterId} doc={draft.doc} editable={editable && !conflict} onSave={() => void save()} onChange={(doc) => {
          const parsed = nodeSchema.safeParse(doc)
          if (parsed.success) setDraft((current) => ({ ...current, doc: parsed.data }))
        }} /></Suspense> : <Field label={draft.format === 'markdown' ? 'Markdown source' : 'Email HTML'}>{(id) => <Textarea id={id} disabled={!editable} className="min-h-96 font-mono" value={draft.format === 'markdown' ? draft.source : draft.html || draft.source} onChange={(e) => setDraft(draft.format === 'markdown' ? { ...draft, source: e.target.value } : { ...draft, html: e.target.value, source: '' })} />}</Field>}
        {draft.format === 'html' && <Field label="Plain text alternative">{(id) => <Textarea id={id} disabled={!editable} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />}</Field>}
        <AudiencePicker newsletterId={initial.newsletterId} value={draft.audience} disabled={!editable || conflict} onChange={(audience) => setDraft({ ...draft, audience })} />
      </div>{showPreview && (preview.error ? <Banner kind="danger">{preview.error.message}</Banner> : preview.data ? <Preview email={preview.data.email.html} web={preview.data.web.html} /> : <Spinner />)}</div>
    </> : <>
      {serialized !== saved && <Banner kind="warn">Save your changes before reviewing or sending.</Banner>}
      {preview.error && <Banner kind="danger">{preview.error.message}</Banner>}
      {preview.data && (step === 'review' || editable) && <><section className="space-y-3 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">Review your issue</h2>{preview.data.checks.length ? preview.data.checks.map((check) => <Banner key={check.id} kind={check.level === 'error' ? 'danger' : 'warn'}>{check.message}</Banner>) : <Banner kind="ok">{editable ? 'Your issue is ready for the send step.' : 'No problems found.'}</Banner>}
        <p className="text-sm text-fg-3">Subject: {preview.data.email.subject || 'No subject'} · {Math.ceil(new TextEncoder().encode(preview.data.email.html).length / 1024)} KB</p>
        <TestSend campaignId={initial.id} />
      </section><Preview email={preview.data.email.html} web={preview.data.web.html} /></>}
      {step === 'send' && (editable ? <SendStep campaign={initial} checks={preview.data?.checks ?? []} unsaved={serialized !== saved} onDone={reload} /> : <Progress campaign={initial} onChange={reload} />)}
    </>}
  </div>
}
export const campaignsFeature: Feature = {
  name: 'campaigns', nav: [{ to: '/campaigns', label: 'Campaigns', icon: Send }],
  routes: [{ path: 'campaigns', element: <CampaignList /> }, { path: 'campaigns/:id', element: <CampaignPage /> }],
}
