import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Campaign, ReviewCheck } from '../../../../server/account/campaigns/index.ts'
import { useSession } from '../../lib/session.tsx'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { Badge, Banner, Button, Field, Input, Select, Spinner, StatusBadge, statusLabel, Switch, useFeedback } from '../../ui/index.tsx'

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const zones = (): string[] => {
  try { return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone') } catch { return ['UTC'] }
}
/** The epoch for a `datetime-local` value read in a time zone, found through the zone's offset at that moment. */
export function epochInZone(local: string, zone: string): number | null {
  const [date, time] = local.split('T')
  if (!date || !time) return null
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const seen = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return Number.isFinite(seen) ? guess - (seen - guess) : null
}
const localValue = (at: number) => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const when = (at: number | null | undefined) => at ? new Date(at).toLocaleString() : ''

export function TestSend({ campaignId }: { campaignId: string }) {
  const [to, setTo] = useState('')
  const [done, setDone] = useState('')
  const send = useAction('campaigns.sendTest', { onSuccess: (r) => setDone(r.failed.length ? `Could not send to ${r.failed.map((f) => f.to).join(', ')}: ${r.failed[0].error}` : `Sent to ${r.sent.join(', ')}.`) })
  const addresses = to.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
  return <form className="space-y-2" onSubmit={(e) => {
    e.preventDefault()
    setDone('')
    if (addresses.length) send.mutate({ campaignId, to: addresses })
  }}>
    <Field label="Send a test" hint={addresses.length > 5 ? 'Up to five addresses.' : 'Up to five addresses, separated by commas. The subject is marked as a test.'} error={send.error?.message}>{(id) => <div className="flex flex-wrap gap-2"><Input id={id} className="min-w-0 flex-1" placeholder="you@example.com, editor@example.com" value={to} onChange={(e) => setTo(e.target.value)} /><Button type="submit" loading={send.isPending} disabled={!addresses.length || addresses.length > 5}>Send test</Button></div>}</Field>
    {done && <p role="status" className="text-sm text-fg-3">{done}</p>}
  </form>
}

export function SendStep({ campaign, checks, unsaved, onDone }: {
  campaign: Campaign
  checks: ReviewCheck[]
  unsaved: boolean
  onDone(): unknown
}) {
  const { current } = useSession()
  const { confirm } = useFeedback()
  const count = useActionQuery('campaigns.audienceCount', { campaignId: campaign.id })
  const [mode, setMode] = useState<'now' | 'later'>('now')
  const [gradual, setGradual] = useState(false)
  const [engagedFirst, setEngagedFirst] = useState(false)
  const [zone, setZone] = useState(current?.timezone || browserZone())
  const [local, setLocal] = useState(() => localValue(Date.now() + 3_600_000))
  const send = useAction('campaigns.send', { invalidate: ['campaigns.get', 'campaigns.list', 'campaigns.progress'], onSuccess: onDone })
  const schedule = useAction('campaigns.schedule', { invalidate: ['campaigns.get', 'campaigns.list', 'campaigns.progress'], onSuccess: onDone })
  const errors = checks.filter((c) => c.level === 'error')
  const blocked = unsaved || errors.length > 0 || !count.data || count.data.total === 0
  const scheduledAt = epochInZone(local, zone)
  const error = send.error?.message || schedule.error?.message
  return <section className="space-y-4 rounded-xl border border-line bg-surface p-4">
    <h2 className="font-semibold">Send</h2>
    {count.isPending ? <Spinner /> : count.error ? <Banner kind="danger">{count.error.message}</Banner> : count.data.total === 0 ? <Banner kind="warn">Nobody is subscribed in this audience yet. <Link className="underline" to="/contacts">Add contacts</Link> or change the audience in the Write step.</Banner> : <p className="text-sm">This issue goes to <strong>{count.data.total.toLocaleString()}</strong> subscribers. {count.data.fresh > 0 && <>{count.data.fresh.toLocaleString()} were never emailed from this account. </>}{count.data.engaged > 0 && <>{count.data.engaged.toLocaleString()} opened or clicked in the last 90 days.</>}</p>}
    {errors.length > 0 && <Banner kind="danger">Fix the review errors before sending.</Banner>}
    <div className="space-y-3">
      <Switch checked={gradual} onChange={setGradual} label="Send gradually to new contacts" description="A random 2% first, then 5% more, then the rest, 30 minutes apart. Each step waits while bounces and complaints stay low." disabled={!count.data?.fresh} />
      <Switch checked={engagedFirst} onChange={setEngagedFirst} label="Most engaged first" description="Recently engaged subscribers get it now. The rest follow a day later, or sooner when you choose." disabled={!count.data?.engaged} />
    </div>
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="When to send"><Button aria-pressed={mode === 'now'} onClick={() => setMode('now')}>Send now</Button><Button aria-pressed={mode === 'later'} onClick={() => setMode('later')}>Schedule</Button></div>
    {mode === 'later' && <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Date and time">{(id) => <Input id={id} type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />}</Field>
      <Field label="Time zone" hint={scheduledAt ? `Sends ${when(scheduledAt)} in your local time.` : 'Pick a date and time.'}>{(id) => <Select id={id} value={zone} onChange={(e) => setZone(e.target.value)}>{zones().map((z) => <option key={z} value={z}>{z}</option>)}</Select>}</Field>
    </div>}
    {error && <Banner kind="danger">{error}</Banner>}
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" disabled={blocked || (mode === 'later' && !scheduledAt)} loading={send.isPending || schedule.isPending} onClick={async () => {
        const total = count.data?.total ?? 0
        if (mode === 'now') {
          if (await confirm({ title: `Send to ${total.toLocaleString()} subscribers?`, body: 'This cannot be undone once emails leave.', confirmLabel: 'Send now' })) send.mutate({ campaignId: campaign.id, gradual, engagedFirst })
        } else if (scheduledAt) schedule.mutate({ campaignId: campaign.id, scheduledAt, gradual, engagedFirst })
      }}>{mode === 'now' ? 'Send now' : 'Schedule send'}</Button>
      {unsaved && <span className="text-sm text-fg-3">Save your changes first.</span>}
    </div>
  </section>
}

const LABELS: [string, string][] = [['sent', 'Sent'], ['delivered', 'Delivered'], ['opens', 'Opened'], ['clicks', 'Clicked'], ['bounced', 'Bounced'], ['complained', 'Complaints'], ['unsubscribes', 'Unsubscribed'], ['failed', 'Failed'], ['skipped', 'Skipped'], ['unknown', 'Unknown']]

export function Progress({ campaign, onChange }: {
  campaign: Campaign
  onChange(): unknown
}) {
  const { confirm } = useFeedback()
  const live = campaign.status === 'sending' || campaign.status === 'scheduled'
  const progress = useActionQuery('campaigns.progress', { campaignId: campaign.id }, { refetchInterval: live ? 3000 : false })
  const status = progress.data?.status ?? campaign.status
  useEffect(() => {
    if (progress.data && progress.data.status !== campaign.status) void onChange()
  }, [progress.data, campaign.status, onChange])
  const opts = { invalidate: ['campaigns.get', 'campaigns.list', 'campaigns.progress'] as const, onSuccess: () => void onChange() }
  const pause = useAction('campaigns.pause', { ...opts, invalidate: [...opts.invalidate] })
  const resume = useAction('campaigns.resume', { ...opts, invalidate: [...opts.invalidate] })
  const cancel = useAction('campaigns.cancel', { ...opts, invalidate: [...opts.invalidate] })
  const more = useAction('campaigns.sendMore', { ...opts, invalidate: [...opts.invalidate] })
  const error = pause.error?.message || resume.error?.message || cancel.error?.message || more.error?.message
  if (progress.isPending) return <Spinner />
  if (progress.error) return <Banner kind="danger">{progress.error.message}</Banner>
  const { counts, steps } = progress.data
  const done = counts.planned - counts.queued - counts.sending
  const pct = counts.planned ? Math.round((done / counts.planned) * 100) : 0
  const pending = steps.find((s) => s.state === 'pending')
  return <section className="space-y-4 rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{status === 'scheduled' ? 'Scheduled' : status === 'sent' ? 'Sent' : status === 'paused' ? 'Paused' : status === 'canceled' ? 'Canceled' : 'Sending'}</h2><StatusBadge status={status} /></div>
    {status === 'scheduled' && <p className="text-sm">Goes out {when(progress.data.scheduledAt)}.</p>}
    {status === 'paused' && progress.data.pauseMessage && <Banner kind="warn">{progress.data.pauseMessage}</Banner>}
    {status === 'sent' && <p className="text-sm text-fg-3">Finished {when(progress.data.sentAt)}. <Link className="underline" to={`/campaigns/${campaign.id}/report`}>Open the report</Link></p>}
    {status !== 'scheduled' && status !== 'canceled' && <>
      <div className="h-2 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Send progress"><div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} /></div>
      <p className="text-sm text-fg-3">{done.toLocaleString()} of {counts.planned.toLocaleString()} handled{counts.queued ? `, ${counts.queued.toLocaleString()} waiting` : ''}{counts.sending ? `, ${counts.sending} in flight` : ''}</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">{LABELS.map(([key, label]) => <div key={key} className="rounded-lg bg-sunken p-3"><dt className="text-xs text-fg-3">{label}</dt><dd className="text-lg font-semibold">{(counts[key as keyof typeof counts] ?? 0).toLocaleString()}</dd></div>)}</dl>
    </>}
    {steps.length > 1 && <ol className="space-y-1 text-sm">{steps.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-2"><Badge tone={s.state === 'done' ? 'ok' : s.state === 'released' ? 'accent' : 'neutral'}>{statusLabel(s.state)}</Badge><span>Step {s.step}: {s.kind === 'warmup' ? 'warm-up' : s.kind === 'more' ? 'the rest' : 'main'} · {s.planned.toLocaleString()} subscribers{s.state === 'pending' && s.releaseAt ? ` · releases ${when(s.releaseAt)}` : ''}</span></li>)}</ol>}
    {error && <Banner kind="danger">{error}</Banner>}
    <div className="flex flex-wrap gap-2">
      {status === 'sending' && <Button loading={pause.isPending} onClick={() => pause.mutate({ campaignId: campaign.id })}>Pause</Button>}
      {status === 'sending' && pending && <Button loading={more.isPending} onClick={() => more.mutate({ campaignId: campaign.id })}>Send to more now</Button>}
      {status === 'paused' && <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate({ campaignId: campaign.id })}>Resume</Button>}
      {status === 'paused' && <Button variant="danger" loading={cancel.isPending} onClick={async () => { if (await confirm({ title: 'Stop this send?', body: `${counts.queued.toLocaleString()} subscribers will not get this issue.`, confirmLabel: 'Stop send', danger: true })) cancel.mutate({ campaignId: campaign.id }) }}>Stop and skip the rest</Button>}
      {status === 'scheduled' && <Button variant="danger" loading={cancel.isPending} onClick={async () => { if (await confirm({ title: 'Cancel this schedule?', body: 'The issue will not be sent.', confirmLabel: 'Cancel schedule', danger: true })) cancel.mutate({ campaignId: campaign.id }) }}>Cancel schedule</Button>}
    </div>
  </section>
}
