import { useState } from 'react'
import { HeartPulse } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Feature } from '../../app/feature.ts'
import type { ActionOutput } from '../../../../server/registry.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Spinner, Switch, Table, Textarea, useFeedback } from '../../ui/index.tsx'

export function ListHealthPage() {
  const { current, account, boot } = useSession()
  const query = useActionQuery('hygiene.health', { newsletterId: current?.id ?? '' }, { enabled: !!current })
  const resume = useAction('hygiene.resume', { invalidate: ['hygiene.health'] })
  const feedback = useFeedback()
  if (!current) return <EmptyState title="Choose a newsletter" body="Create or select a newsletter to see its list health." />
  if (query.isPending) return <Spinner />
  if (query.error) return <Banner kind="danger">{query.error.message}</Banner>
  const h = query.data
  if (!h) return null
  return <div className="flex flex-col gap-5">
    <PageHeader title="List health" description="See who is subscribed and whether your sending reputation needs attention." action={<Link to="/settings/hygiene" className="text-sm text-accent-fg">Hygiene settings</Link>} />
    {resume.error && <Banner kind="danger">{resume.error.message}</Banner>}
    {h.protection && <Banner kind="danger"><p className="font-medium">Sending is paused</p><p className="mt-1">{h.protection.reason === 'spam_trap' ? 'A recipient matched the global spam-trap list.' : 'Your account crossed a bounce or complaint limit.'} Review how these addresses joined your lists and remove unwanted or invalid addresses.{boot.cloud ? ' Ask the install administrator to unblock the account, then resume here.' : ' Resume only after reviewing the cause.'}</p>{account?.owner && <Button className="mt-3" loading={resume.isPending} onClick={async () => { if (await feedback.confirm({ title: 'Resume sending?', body: 'Confirm you have reviewed your lists and addressed the cause. This resumes sends held by account protection.', confirmLabel: 'Resume sending' })) resume.mutate({ accountId: account.id, confirmation: 'RESUME' }) }}>Resume sending</Button>}</Banner>}
    {!h.enabled && <Banner kind="warn">Automatic list hygiene is off. Account reputation protection remains on.</Banner>}
    <div className="grid gap-3 sm:grid-cols-3">{[
      ['At risk', h.atRisk, `Subscribed for at least 90 days and ignored ${h.afterIssues} consecutive issues.`],
      ['Waiting for a reply', h.awaitingReply, `A keep-subscription email was sent. No confirmation within ${h.waitDays} days means cleaning.`],
      ['Cleaned in 90 days', h.cleanedLast90Days, 'Removed from this newsletter after no reply. They can sign up and confirm again.'],
    ].map(([label, count, text]) => <Card key={label} className="p-4"><h2 className="text-sm text-fg-3">{label}</h2><p className="my-2 text-2xl font-semibold">{count}</p><p className="text-sm text-fg-3">{text}</p></Card>)}</div>
    <Card className="p-4"><h2 className="font-semibold">{h.ratesScope === 'account' ? 'Account' : 'Newsletter'} reputation</h2><p className="mt-1 text-sm text-fg-3">The latest {h.rates.total.toLocaleString()} sent emails since the last explicit resume, up to 1,000. Account protection pauses sends above 5% hard bounces or 0.3% complaints once 1,000 emails are available.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><p className="text-sm">Hard bounces: {(h.rates.bounceRate * 100).toFixed(2)}% / 5% limit</p><progress aria-label="Hard bounce rate against limit" className="mt-2 w-full accent-[var(--accent)]" max={h.rates.bounceLimit} value={h.rates.bounceRate} /></div><div><p className="text-sm">Complaints: {(h.rates.complaintRate * 100).toFixed(2)}% / 0.3% limit</p><progress aria-label="Complaint rate against limit" className="mt-2 w-full accent-[var(--accent)]" max={h.rates.complaintLimit} value={h.rates.complaintRate} /></div></div>{h.rates.total < h.rates.minimum && <p className="mt-3 text-sm text-fg-3">There is not enough sending history to judge rates yet. A spam-trap hit pauses sending immediately.</p>}</Card>
    {h.statuses.length ? <Table head={<tr><th>Status</th><th>Contacts</th></tr>}>{h.statuses.map((row) => <tr key={row.status}><td>{row.status}</td><td>{row.count.toLocaleString()}</td></tr>)}</Table> : <Card><EmptyState title="No contacts yet" body="Add subscribers or import a list with consent to start tracking list health." action={<Link to="/contacts" className="text-accent-fg">Go to contacts</Link>} /></Card>}
  </div>
}

function SettingsForm({ newsletterId, initial }: { newsletterId: string; initial: ActionOutput<'hygiene.settings'> }) {
  const [settings, setSettings] = useState(initial)
  const feedback = useFeedback()
  const save = useAction('hygiene.updateSettings', { invalidate: ['hygiene.settings', 'hygiene.health'], onSuccess: () => feedback.toast('Hygiene settings saved') })
  return <form className="flex max-w-2xl flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save.mutate({ newsletterId, ...settings }) }}>
    {save.error && <Banner kind="danger">{save.error.message}</Banner>}
    <Card className="flex flex-col gap-5 p-4">
      <Switch label="Automatic list hygiene" description="Ask inactive subscribers if they want to stay, then clean those who do not reply." checked={settings.enabled} onChange={(enabled) => setSettings({ ...settings, enabled })} />
      <Field label="Ignored issues before asking" hint="Only contacts subscribed for at least 90 days qualify. Nobody is asked more than once in 180 days.">{(id) => <Input id={id} type="number" min={1} max={100} required value={settings.afterIssues} onChange={(e) => setSettings({ ...settings, afterIssues: e.target.valueAsNumber })} />}</Field>
      <Field label="Days to wait before cleaning" hint="The clock starts when the reminder is sent. Changes apply to future reminders.">{(id) => <Input id={id} type="number" min={1} max={30} required value={settings.waitDays} onChange={(e) => setSettings({ ...settings, waitDays: e.target.valueAsNumber })} />}</Field>
      <Switch label="Strict engagement" description="Privacy-proxy opens do not count as reading an issue. Human opens and clicks count." checked={settings.strict} onChange={(strict) => setSettings({ ...settings, strict })} />
    </Card>
    <Card className="flex flex-col gap-4 p-4"><h2 className="font-semibold">Keep-subscription email</h2><p className="text-sm text-fg-3">Uses your newsletter design and sender. The confirmation link and unsubscribe footer are added automatically.</p><Field label="Subject">{(id) => <Input id={id} required maxLength={150} value={settings.subject} onChange={(e) => setSettings({ ...settings, subject: e.target.value })} />}</Field><Field label="Message" hint="Markdown is supported.">{(id) => <Textarea id={id} required maxLength={5000} rows={6} value={settings.body} onChange={(e) => setSettings({ ...settings, body: e.target.value })} />}</Field></Card>
    <p className="text-sm text-fg-3">Turning hygiene off stops reminders and cleaning. It does not turn off bounce, complaint or spam-trap protection.</p>
    <Button className="self-start" type="submit" variant="primary" loading={save.isPending}>Save settings</Button>
  </form>
}
export function HygieneSettingsPage() {
  const { current } = useSession()
  const query = useActionQuery('hygiene.settings', { newsletterId: current?.id ?? '' }, { enabled: !!current })
  if (!current) return <EmptyState title="Choose a newsletter" body="Create or select a newsletter to configure hygiene." />
  return <div className="flex flex-col gap-5"><PageHeader title="List hygiene" description="Keep your list active without emailing people who no longer want it." />{query.isPending && <Spinner />}{query.error && <Banner kind="danger">{query.error.message}</Banner>}{query.data && <SettingsForm key={current.id} newsletterId={current.id} initial={query.data} />}</div>
}
export const hygieneFeature: Feature = {
  name: 'hygiene',
  nav: [{ to: '/list-health', label: 'List health', icon: HeartPulse }],
  routes: [{ path: 'list-health', element: <ListHealthPage /> }],
  settings: [{ to: '/settings/hygiene', label: 'List hygiene' }],
  settingsRoutes: [{ path: 'hygiene', element: <HygieneSettingsPage /> }],
}
