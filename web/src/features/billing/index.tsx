import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import type { Feature } from '../../app/feature.ts'
import { useSession } from '../../lib/session.tsx'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { Badge, Banner, Button, Card, Meter as Bar, NoAccess, PageHeader, Select, Spinner, StatusBadge, useFeedback } from '../../ui/index.tsx'

function BillingPage() {
  const { boot, account } = useSession()
  if (!boot.cloud) return <Navigate to="/settings/account" replace />
  if (!account?.owner) return <NoAccess title="Only the owner manages billing" body="Ask the account owner to change the plan." />
  return <Billing accountId={account.id} />
}
function Billing({ accountId }: { accountId: string }) {
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly')
  const [notice, setNotice] = useState('')
  const feedback = useFeedback()
  const query = useActionQuery('billing.get', { accountId }, { refetchInterval: 15_000 })
  const checkout = useAction('billing.checkout', { onSuccess: ({ url }) => window.location.assign(url) })
  const portal = useAction('billing.portal', { onSuccess: ({ url }) => window.location.assign(url) })
  const change = useAction('billing.changePlan', { invalidate: ['billing.get'], onSuccess: () => setNotice('Your plan will update after the payment provider confirms it.') })
  const cancel = useAction('billing.cancel', { invalidate: ['billing.get'], onSuccess: () => setNotice('Cancellation requested. Your plan updates after confirmation and the grace period.') })
  const busy = checkout.isPending || portal.isPending || change.isPending || cancel.isPending
  const error = query.error || checkout.error || portal.error || change.error || cancel.error
  const data = query.data
  return <div className="flex flex-col gap-5">
    <PageHeader title="Billing" description="Plans and prices in USD." />
    {error && <Banner kind="danger">{error.message}</Banner>}
    {notice && <Banner>{notice}</Banner>}
    {query.isPending && <Spinner />}
    {data && <>
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-lg font-semibold"><span className="capitalize">{data.plan}</span> plan</h2>{data.status && <StatusBadge status={data.status} />}</div>
        {data.graceUntil && <Banner kind="warn">Free limits apply after {new Date(data.graceUntil).toLocaleDateString()} unless payment is recovered.</Banner>}
        <Meter label="Contacts" value={data.usage.contacts} max={data.limits.maxContacts} />
        <Meter label="Emails this month" value={data.usage.emailsSent} max={data.limits.maxEmailsPerMonth} />
        <p className="text-xs text-fg-3">Usage can take up to an hour to update.</p>
        {data.periodEnd && <p className="text-sm text-fg-2">Billing period ends {new Date(data.periodEnd).toLocaleDateString()}.</p>}
        <div className="flex flex-wrap gap-2">
          {data.hasCustomer && <><Button disabled={busy} onClick={() => portal.mutate({ accountId })}>Manage billing</Button><Button disabled={busy} onClick={() => portal.mutate({ accountId })}>View invoices</Button></>}
          {data.hasSubscription && <Button variant="danger" disabled={busy} onClick={async () => { if (await feedback.confirm({ title: 'Cancel this subscription?', body: 'Your account returns to free limits after the grace period.', confirmLabel: 'Cancel subscription', danger: true })) cancel.mutate({ accountId }) }}>Cancel subscription</Button>}
        </div>
      </Card>
      <label className="flex max-w-xs flex-col gap-2 text-sm">Billing interval<Select value={interval} onChange={(e) => setInterval(e.target.value === 'yearly' ? 'yearly' : 'monthly')}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></Select></label>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{data.plans.map((plan) => <Card key={plan.name} className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold capitalize">{plan.name}</h2>{plan.name === data.plan && <Badge tone="accent">Current plan</Badge>}</div><p><strong>${(plan[interval] / 100).toLocaleString()}</strong> / {interval === 'monthly' ? 'month' : 'year'}</p>
        <p className="text-sm text-fg-2">{plan.maxContacts.toLocaleString()} contacts<br />{plan.maxEmailsPerMonth.toLocaleString()} emails per month<br />{plural(plan.maxNewsletters, 'newsletter')}<br />{plural(plan.maxTeamPerNewsletter, 'team member')} per newsletter</p>
        {plan.name !== 'free' && <Button className="mt-auto" variant={plan.name === data.plan ? 'secondary' : 'primary'} disabled={busy} onClick={() => { if (plan.name === 'free') return; const input = { accountId, plan: plan.name, interval }; if (data.hasSubscription) change.mutate(input); else checkout.mutate(input) }}>{data.hasSubscription ? `Choose ${plan.name}` : `Get ${plan.name}`}</Button>}
        {plan.name === 'free' && <p className="text-xs text-fg-3">{data.hasSubscription ? 'Cancel your subscription to return to free.' : 'No payment required.'}</p>}
      </Card>)}</div>
    </>}
  </div>
}
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
function Meter({ label, value, max }: { label: string; value: number; max: number | null }) {
  return <div><div className="mb-1 flex justify-between gap-2 text-sm"><span>{label}</span><span>{value.toLocaleString()} / {max?.toLocaleString() ?? 'Unlimited'}</span></div><Bar label={label} max={max || Math.max(value, 1)} value={Math.min(value, max || value)} tone={max && value >= max ? 'danger' : 'accent'} /></div>
}
export const billingFeature: Feature = { name: 'billing', settings: [{ to: '/settings/billing', label: 'Billing', role: 'owner' }], settingsRoutes: [{ path: 'billing', element: <BillingPage /> }] }
