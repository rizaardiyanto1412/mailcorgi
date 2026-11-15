import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Upload } from 'lucide-react'
import { z } from 'zod'
import { Banner, Button, Card, EmptyState, Field, Input, Meter, NoAccess, PageHeader, Select, StatusBadge, statusLabel, Table } from '../../ui/index.tsx'
import { callAction, useActionQuery } from '../../lib/api.ts'
import { useSession, useDocumentTitle, readLocal, writeLocal } from '../../lib/session.tsx'
import type { Feature } from '../../app/feature.ts'
import { detectPreset, presetNames, suggestMapping } from '../../../../server/account/imports/presets.ts'
import { mappingSchema, optionsSchema, type CsvRow, type Mapping } from '../../../../server/account/imports/model.ts'

const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preview'), headers: z.array(z.string()), rows: z.array(z.record(z.string(), z.string())) }),
  z.object({ kind: z.literal('chunk'), seq: z.number(), rows: z.array(z.record(z.string(), z.string())), total: z.number(), final: z.boolean().optional() }),
  z.object({ kind: z.literal('complete'), total: z.number() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
])
const savedSchema = z.object({ id: z.string(), name: z.string(), size: z.number(), modified: z.number(), newsletterId: z.string() })
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Try again.'
const labels = { email: 'Email', name: 'Full name', firstName: 'First name', lastName: 'Last name', status: 'Status', signupDate: 'Signup date', unsubscribeDate: 'Unsubscribe date', tags: 'Tags' } satisfies Record<Exclude<keyof Mapping, 'fields'>, string>

function ImportWorkspace() {
  useDocumentTitle('Imports')
  const { current, account } = useSession()
  const newsletterId = current?.id ?? ''
  const [search, setSearch] = useSearchParams()
  const selected = search.get('import') ?? ''
  const history = useActionQuery('imports.list', { newsletterId }, { enabled: !!newsletterId, refetchInterval: 3000 })
  const report = useActionQuery('imports.get', { newsletterId, importId: selected }, { enabled: !!newsletterId && !!selected, refetchInterval: 2000 })
  const fields = useActionQuery('contactFields.list', { newsletterId }, { enabled: !!newsletterId })
  const tags = useActionQuery('tags.list', { newsletterId }, { enabled: !!newsletterId })
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ headers: string[]; rows: CsvRow[] } | null>(null)
  const [mapping, setMapping] = useState<Mapping>({ email: '', fields: {} })
  const [preset, setPreset] = useState<typeof presetNames[number]>('generic')
  const [options, setOptions] = useState(optionsSchema.parse({}))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploaded, setUploaded] = useState(0)
  const [newField, setNewField] = useState({ key: '', label: '', header: '' })
  const worker = useRef<Worker | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [resume, setResume] = useState<(() => Promise<void>) | null>(null)
  const [locked, setLocked] = useState(false)
  const importId = useRef<string | null>(null)
  const storageKey = `mc-import:${account?.id}:${newsletterId}`
  useEffect(() => () => worker.current?.terminate(), [])
  const canImport = account?.owner || account?.grants[newsletterId] === 'admin'

  const selectFile = (csv: File) => {
    worker.current?.terminate(); setResume(null); setLocked(false); importId.current = null
    setBusy(false); setError(''); setPreview(null); setUploaded(0)
    if (csv.size > 100 * 1024 * 1024) { setError('Choose a CSV up to 100 MB.'); return }
    setFile(csv)
    const instance = new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' })
    worker.current = instance
    instance.onerror = () => { setError('The CSV could not be read.'); setBusy(false) }
    instance.onmessage = (event: MessageEvent<unknown>) => {
      const message = messageSchema.parse(event.data)
      if (message.kind === 'error') { setError(message.message); instance.terminate() }
      if (message.kind === 'preview') {
        instance.terminate()
        if (!message.headers.length || !message.rows.length) { setError('This CSV has no contacts.'); return }
        setPreview(message)
        setMapping(suggestMapping(message.headers)); setPreset(detectPreset(message.headers))
        setOptions(optionsSchema.parse({}))
      }
    }
    instance.postMessage({ kind: 'preview', file: csv })
  }

  const upload = async () => {
    if (!file || !preview || !newsletterId || !mapping.email) { setError('Choose an email column.'); return }
    setError(''); setBusy(true)
    try {
      let id = importId.current
      const rawSaved = readLocal(storageKey)
      const saved = savedSchema.safeParse(rawSaved ? JSON.parse(rawSaved) : null)
      if (!id && saved.success && saved.data.name === file.name && saved.data.size === file.size && saved.data.modified === file.lastModified && saved.data.newsletterId === newsletterId) {
        const previous = await callAction('imports.get', { newsletterId, importId: saved.data.id })
        if (previous.status === 'uploading') { id = previous.id; setMapping(previous.mapping); setOptions(previous.options); setPreset(z.enum(presetNames).parse(previous.preset)) }
      }
      if (!id) {
        const created = await callAction('imports.create', { newsletterId, preset, mapping: mappingSchema.parse(mapping), options })
        id = created.id
        writeLocal(storageKey, JSON.stringify({ id, name: file.name, size: file.size, modified: file.lastModified, newsletterId }))
      }
      importId.current = id; setLocked(true)
      setSearch({ import: id })
      const target = { newsletterId, importId: id }
      const finish = async (totalRows: number) => {
        await callAction('imports.start', { ...target, totalRows })
        writeLocal(storageKey, ''); setResume(null); setBusy(false); worker.current?.terminate()
        void history.refetch(); void report.refetch()
      }
      const instance = new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' })
      worker.current = instance
      const fail = (e: unknown) => { setError(errorText(e)); setBusy(false) }
      instance.onerror = () => fail(new Error('The CSV could not be read. Reselect it to resume.'))
      instance.onmessage = (event: MessageEvent<unknown>) => {
        const parsed = messageSchema.safeParse(event.data)
        if (!parsed.success) { fail(new Error('The CSV could not be read.')); return }
        const message = parsed.data
        if (message.kind === 'error') { setResume(null); fail(new Error(message.message)); instance.terminate(); return }
        if (message.kind === 'chunk') {
          const send = async () => {
            await callAction('imports.addChunk', { ...target, seq: message.seq, rows: message.rows })
            setUploaded(message.total)
            if (message.final) await finish(message.total)
            else { setResume(null); instance.postMessage({ kind: 'continue' }) }
          }
          setResume(() => send)
          void send().catch(fail)
        } else if (message.kind === 'complete') {
          setResume(() => () => finish(message.total))
          void finish(message.total).catch(fail)
        }
      }
      instance.postMessage({ kind: 'upload', file })
    } catch (e) { setError(errorText(e)); setBusy(false) }
  }

  const createField = async () => {
    try {
      setError('')
      const field = await callAction('contactFields.create', { newsletterId, key: newField.key, label: newField.label, type: 'text' })
      setMapping({ ...mapping, fields: { ...mapping.fields, [field.key]: newField.header } })
      setNewField({ key: '', label: '', header: '' }); await fields.refetch()
    } catch (e) { setError(errorText(e)) }
  }
  if (!current) return <EmptyState title="Choose a newsletter" body="Create or select a newsletter before importing contacts." />
  return <div className="flex flex-col gap-5">
    <PageHeader title="Imports" description="Bring your contacts and their consent history with you." />
    {error && <Banner kind="danger">{error}</Banner>}
    {canImport ? <section className="space-y-4 rounded-xl border border-line bg-surface p-4">
      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!busy && e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]) }} className="rounded-lg border border-dashed border-line-strong p-6 text-center">
        <Upload className="mx-auto mb-2 size-6 text-fg-3" /><p className="mb-3 text-sm">Drop a CSV here, or choose a file. Up to 100 MB.</p>
        <input ref={fileInput} id="import-csv" className="sr-only" type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { if (e.target.files?.[0]) selectFile(e.target.files[0]); e.target.value = '' }} />
        <Button disabled={busy} onClick={() => fileInput.current?.click()} aria-controls="import-csv">Choose a CSV file</Button>
        {file && <p className="mt-2 break-all text-sm text-fg-3">{file.name}</p>}
      </div>
      {preview && <fieldset disabled={busy || locked} className="space-y-4 disabled:opacity-60">
        <Field label="Export platform" hint="Check the suggested mapping before importing.">{(id) => <Select id={id} value={preset} onChange={(e) => { const p = presetNames.find((p) => p === e.target.value); if (p) setPreset(p) }}>{presetNames.map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
        <div className="overflow-x-auto"><Table head={<tr>{preview.headers.map((h) => <th key={h}>{h}</th>)}</tr>}>{preview.rows.map((r, i) => <tr key={i}>{preview.headers.map((h) => <td key={h} className="max-w-48 truncate">{r[h]}</td>)}</tr>)}</Table></div>
        <div className="grid gap-3 sm:grid-cols-2">{Object.entries(labels).map(([key, label]) => <Field key={key} label={label}>{(id) => <Select id={id} value={mapping[key as keyof typeof labels] ?? ''} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value || undefined })}><option value="">{key === 'email' ? 'Choose a column' : 'Do not map'}</option>{preview.headers.map((h) => <option key={h}>{h}</option>)}</Select>}</Field>)}</div>
        <div className="grid gap-3 sm:grid-cols-2">{fields.data?.fields.map((field) => <Field key={field.key} label={field.label}>{(id) => <Select id={id} value={mapping.fields[field.key] ?? ''} onChange={(e) => { const next = { ...mapping.fields }; if (e.target.value) next[field.key] = e.target.value; else delete next[field.key]; setMapping({ ...mapping, fields: next }) }}><option value="">Do not map</option>{preview.headers.map((h) => <option key={h}>{h}</option>)}</Select>}</Field>)}</div>
        <div className="grid gap-2 sm:grid-cols-4"><Input aria-label="New field key" placeholder="New field key" value={newField.key} onChange={(e) => setNewField({ ...newField, key: e.target.value })} /><Input aria-label="New field label" placeholder="Field label" value={newField.label} onChange={(e) => setNewField({ ...newField, label: e.target.value })} /><Select aria-label="New field CSV column" value={newField.header} onChange={(e) => setNewField({ ...newField, header: e.target.value })}><option value="">CSV column</option>{preview.headers.map((h) => <option key={h}>{h}</option>)}</Select><Button onClick={() => void createField()} disabled={!newField.key || !newField.label || !newField.header}>Create field</Button></div>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Status when no column exists" hint="For Mailchimp, choose the status named in the exported file.">{(id) => <Select id={id} value={options.defaultStatus} onChange={(e) => setOptions(optionsSchema.parse({ ...options, defaultStatus: e.target.value }))}><option value="pending">Unconfirmed</option><option value="subscribed">Subscribed</option><option value="unsubscribed">Unsubscribed</option><option value="cleaned">Cleaned</option></Select>}</Field><Field label="Inactive rows">{(id) => <Select id={id} value={options.statuses} onChange={(e) => setOptions(optionsSchema.parse({ ...options, statuses: e.target.value }))}><option value="preserve">Keep opt-outs suppressed</option><option value="activeOnly">Skip inactive rows</option></Select>}</Field><Field label="Tag to add">{(id) => <Select id={id} value={options.tagIds[0] ?? ''} onChange={(e) => setOptions({ ...options, tagIds: e.target.value ? [e.target.value] : [] })}><option value="">No extra tag</option>{tags.data?.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field></div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={options.consent} onChange={(e) => setOptions({ ...options, consent: e.target.checked })} />These active contacts already confirmed consent elsewhere. Suppressed and deleted addresses stay excluded.</label>
      </fieldset>}
      {preview && <div className="flex flex-wrap items-center gap-3"><Button variant="primary" loading={busy} disabled={!mapping.email || !!resume || locked} onClick={() => void upload()}>Upload and import</Button>{resume && !busy && <Button onClick={() => { setError(''); setBusy(true); void resume?.().catch((e: unknown) => { setError(errorText(e)); setBusy(false) }) }}>Resume upload</Button>}<span className="text-sm text-fg-3" role="status">{uploaded > 0 ? `${uploaded.toLocaleString()} rows uploaded` : ''}</span></div>}
    </section> : <NoAccess title="Newsletter admins import contacts" body="Ask an admin or the owner to import a CSV for you." />}
    {report.error && <Banner kind="danger">{report.error.message}</Banner>}
    {report.data && <section className="space-y-3 rounded-xl border border-line bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold">Import report <StatusBadge status={report.data.status} /></h2>{canImport && ['uploading', 'queued', 'processing'].includes(report.data.status) && <Button onClick={() => { void callAction('imports.cancel', { newsletterId, importId: selected }).then(() => { worker.current?.terminate(); setResume(null); setBusy(false); return report.refetch() }).catch((e: unknown) => setError(errorText(e))) }}>Cancel import</Button>}</div><Meter label="Import progress" value={report.data.processedRows} max={report.data.totalRows || 1} /><p className="text-sm">{report.data.processedRows.toLocaleString()} of {report.data.totalRows.toLocaleString()} processed · {report.data.added.toLocaleString()} added</p>{report.data.error && <Banner kind="warn">{report.data.error}</Banner>}<ul className="space-y-1 text-sm">{Object.entries(report.data.skipped).map(([reason, count]) => <li key={reason}>{statusLabel(reason)}: {count.toLocaleString()}</li>)}</ul>{canImport && Object.keys(report.data.skipped).length > 0 && <a className="text-sm text-accent-fg underline" href={`/api/actions/imports.skipped?newsletterId=${encodeURIComponent(newsletterId)}&importId=${encodeURIComponent(selected)}`}>Download skipped rows</a>}{canImport && report.data.status === 'uploading' && <p className="text-sm text-fg-3">Reselect the original CSV to resume an interrupted upload.</p>}</section>}
    {history.error && <Banner kind="danger">{history.error.message}</Banner>}
    <section><h2 className="mb-3 font-semibold">Recent imports</h2>{history.data?.imports.length === 0 ? <Card><EmptyState icon={<Upload />} title="No imports yet" body={canImport ? 'Choose a CSV above to add your first contacts.' : 'Your newsletter admin can import contacts from a CSV.'} /></Card> : <Table head={<tr><th>Started</th><th>Source</th><th>Status</th><th>Added</th><th><span className="sr-only">Report</span></th></tr>}>{history.data?.imports.map((r) => <tr key={r.id}><td className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td><td>{statusLabel(r.preset)}</td><td><StatusBadge status={r.status} /></td><td>{r.added.toLocaleString()}</td><td className="text-right"><Button size="sm" onClick={() => setSearch({ import: r.id })}>View report</Button></td></tr>)}</Table>}</section>
  </div>
}

function ImportsPage() {
  const { current, account } = useSession()
  return <ImportWorkspace key={`${account?.id}:${current?.id}`} />
}

export const importsFeature: Feature = {
  name: 'imports', nav: [{ to: '/imports', label: 'Imports', icon: Upload }],
  routes: [{ path: 'imports', element: <ImportsPage key="imports" /> }],
}
