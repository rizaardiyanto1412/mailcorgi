import { lazy, Suspense, useState } from 'react'
import type { JSONContent } from '@tiptap/react'
import { nodeSchema } from '../../../../server/account/render/doc.ts'
import type { Feature } from '../../app/feature.ts'
import type { ActionOutput } from '../../../../server/registry.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useCanAdmin, useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, NoAccess, PageHeader, Select, Spinner, Textarea } from '../../ui/index.tsx'
const CampaignEditor = lazy(() => import('../campaigns/Editor.tsx').then((module) => ({ default: module.CampaignEditor })))

function FormsPage() {
  useDocumentTitle('Signup forms')
  const { current } = useSession()
  const canAdmin = useCanAdmin()
  const query = useActionQuery('signup.get', { newsletterId: current?.id ?? '' }, { enabled: !!current && canAdmin })
  if (!current) return <EmptyState title="Choose a newsletter" body="Create a newsletter to set up its signup form." />
  if (!canAdmin) return <div className="flex flex-col gap-5"><PageHeader title="Signup forms" description="Invite readers to subscribe on your site or with a hosted form." /><NoAccess title="Newsletter admins manage signup forms" body="Ask an admin or the owner to change the form." /></div>
  if (query.isPending) return <Spinner />
  if (query.error) return <Banner kind="danger">{query.error.message}</Banner>
  return <FormsEditor key={current.id} newsletterId={current.id} initial={query.data} />
}
function FormsEditor({ newsletterId, initial }: { newsletterId: string; initial: ActionOutput<'signup.get'> }) {
  const [settings, setSettings] = useState(initial.settings)
  const [doubleOptIn, setDoubleOptIn] = useState(initial.doubleOptIn)
  const [saved, setSaved] = useState(false)
  const [enabled, setEnabled] = useState(initial.welcomeEnabled)
  const [subject, setSubject] = useState(initial.welcome?.subject ?? 'Welcome!')
  const [doc, setDoc] = useState<JSONContent>(initial.welcome?.doc ?? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Thanks for subscribing, {{first_name|friend}}!' }] }] })
  const [revision, setRevision] = useState(initial.welcome?.revision ?? null)
  const [welcomeSaved, setWelcomeSaved] = useState(false)
  const [validation, setValidation] = useState('')
  const save = useAction('signup.update', { invalidate: ['signup.get'], onSuccess: () => setSaved(true) })
  const welcome = useAction('signup.saveWelcome', { invalidate: ['signup.get', 'campaigns.list', 'campaigns.get'], onSuccess: (data) => { setRevision(data.welcome?.revision ?? null); setWelcomeSaved(true) } })
  const preview = useActionQuery('signup.preview', { newsletterId, settings: { ...settings, buttonLabel: settings.buttonLabel || 'Subscribe', successMessage: settings.successMessage || 'Thanks!', redirectUrl: initial.settings.redirectUrl } })
  const change = (next: typeof settings) => { setSettings(next); setSaved(false) }
  const saveWelcome = () => {
    if (!subject.trim() || subject.length > 150) { setValidation('Use a welcome subject between 1 and 150 characters.'); return }
    const parsed = nodeSchema.safeParse(doc)
    if (!parsed.success) { setValidation('The editor content is invalid. Please reload and try again.'); return }
    setValidation('')
    welcome.mutate({ newsletterId, subject, doc: parsed.data, enabled, revision })
  }
  return <div className="space-y-6">
    <PageHeader title="Signup forms" description="Invite readers to subscribe on your site or with a hosted form." />
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
      <Card><form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate({ newsletterId, settings, doubleOptIn }) }}>
        <h2 className="font-semibold">Form settings</h2>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={doubleOptIn} onChange={(e) => { setDoubleOptIn(e.target.checked); setSaved(false) }} />Require email confirmation</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.showName} onChange={(e) => change({ ...settings, showName: e.target.checked })} />Show name</label>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Custom fields</legend>{initial.fields.length ? initial.fields.map((f) => <label key={f.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.fieldKeys.includes(f.key)} onChange={(e) => change({ ...settings, fieldKeys: e.target.checked ? [...settings.fieldKeys, f.key] : settings.fieldKeys.filter((key) => key !== f.key) })} />{f.label}</label>) : <p className="text-sm text-fg-3">Add custom fields in contact settings to show them here.</p>}</fieldset>
        <Field label="Button label">{(id) => <Input id={id} required maxLength={80} value={settings.buttonLabel} onChange={(e) => change({ ...settings, buttonLabel: e.target.value })} />}</Field>
        <Field label="Success message" hint="Shown for both new and existing readers.">{(id) => <Textarea id={id} required maxLength={1000} value={settings.successMessage} onChange={(e) => change({ ...settings, successMessage: e.target.value })} />}</Field>
        <Field label="Success redirect" hint="Optional. Use a full http or https address.">{(id) => <Input id={id} type="url" maxLength={2048} value={settings.redirectUrl} placeholder="https://example.com/thanks" onChange={(e) => change({ ...settings, redirectUrl: e.target.value })} />}</Field>
        <Field label="Form style">{(id) => <Select id={id} value={settings.style} onChange={(e) => { const style = e.target.value; if (style === 'card' || style === 'inline') change({ ...settings, style }) }}><option value="card">Card</option><option value="inline">Inline</option></Select>}</Field>
        {save.error && <Banner kind="danger">{save.error.message}</Banner>}{saved && <Banner kind="ok">Form settings saved.</Banner>}
        <Button type="submit" variant="primary" loading={save.isPending}>Save form</Button>
      </form></Card>
      <section className="min-w-0 space-y-3"><h2 className="font-semibold">Live preview</h2>{preview.error ? <Banner kind="danger">{preview.error.message}</Banner> : preview.data ? <iframe title="Signup form preview" sandbox="" referrerPolicy="no-referrer" srcDoc={preview.data.html} className="h-[560px] w-full rounded-xl border border-line" /> : <Spinner />}</section>
    </div>
    <Card><div className="min-w-0 space-y-4 p-4"><h2 className="font-semibold">Share your form</h2>
      <a className="break-all text-sm text-accent-fg underline" href={initial.hostedUrl} target="_blank" rel="noreferrer">Open hosted form</a>
      <Field label="Inline embed">{(id) => <Textarea id={id} readOnly value={initial.inlineSnippet} className="font-mono text-xs" />}</Field>
      <Field label="Popup embed">{(id) => <Textarea id={id} readOnly value={initial.popupSnippet} className="font-mono text-xs" />}</Field>
      <Field label="Public API">{(id) => <Input id={id} readOnly value={initial.apiUrl} />}</Field>
      <p className="text-sm text-fg-3">Allow this install’s origin in your site’s script-src and connect-src policy. With Turnstile enabled, also allow challenges.cloudflare.com in script-src, connect-src and frame-src. For API signup, GET the endpoint for a formToken, then POST email and formToken after at least two seconds. Tokens expire after one hour.</p>
    </div></Card>
    <section className="space-y-4"><h2 className="font-semibold">Welcome email</h2><p className="text-sm text-fg-3">Sent once after a reader confirms, or immediately when confirmation is off.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setWelcomeSaved(false) }} />Send a welcome email</label>
      <Field label="Subject">{(id) => <Input id={id} required maxLength={150} value={subject} onChange={(e) => { setSubject(e.target.value); setWelcomeSaved(false) }} />}</Field>
      <Suspense fallback={<Spinner />}><CampaignEditor newsletterId={newsletterId} doc={doc} onChange={(next) => { setDoc(next); setWelcomeSaved(false) }} onSave={saveWelcome} editable /></Suspense>
      {(validation || welcome.error) && <Banner kind="danger">{validation || welcome.error?.message}</Banner>}{welcomeSaved && <Banner kind="ok">Welcome email saved.</Banner>}
      <Button variant="primary" onClick={saveWelcome} loading={welcome.isPending}>Save welcome email</Button>
    </section>
  </div>
}
export const signupFeature: Feature = { name: 'signup', settings: [{ to: '/settings/forms', label: 'Signup forms', role: 'admin' }], settingsRoutes: [{ path: 'forms', element: <FormsPage /> }] }
