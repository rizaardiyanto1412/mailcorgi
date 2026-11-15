import { z } from 'zod'
import type { SmokeContext } from '../../smoke-context.ts'
import { Jar, call, waitUntil } from '../../smoke-context.ts'

/** The second account hits a free-plan limit, pays through the test billing provider and gets its new limits. */
export default async function step({ base, expect, state }: SmokeContext) {
  const second = z.object({ jar: z.instanceof(Jar), accountId: z.string() }).parse(state.get('second'))
  const act = async (name: string, input: unknown = {}, status = 200) => {
    const r = await call(base, second.jar, 'POST', `/api/actions/${name}`, input)
    const data = await r.json().catch(() => null)
    expect(r.status === status, `${name} as the second owner answered ${r.status}: ${JSON.stringify(data)}`)
    return data
  }
  const first = await act('newsletters.create', { name: 'Second Weekly' })
  const refused = await act('newsletters.create', { name: 'One too many' }, 403)
  expect(refused.code === 'limit_reached' && refused.details?.billingUrl === '/settings/billing', 'the free plan allows one newsletter and points at billing')
  const billing = await act('billing.get', { accountId: second.accountId })
  expect(billing.plan === 'free' && billing.hasSubscription === false, 'billing shows the free plan')
  const checkout = await act('billing.checkout', { accountId: second.accountId, plan: 'starter', interval: 'monthly' })
  expect(typeof checkout.url === 'string' && checkout.url.includes('/settings/billing'), 'checkout returns a URL to come back to')
  const hook = await fetch(`${base}/hooks/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'evt_smoke_1', accountId: second.accountId, status: 'active', plan: 'starter', periodEnd: Date.now() + 30 * 86_400_000 }) })
  expect(hook.status === 200 && (await hook.json()).applied === 1, 'the test billing webhook applies the paid subscription')
  const replay = await fetch(`${base}/hooks/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'evt_smoke_1', accountId: second.accountId, status: 'active', plan: 'starter' }) })
  expect((await replay.json()).applied === 0, 'a replayed webhook event is ignored')
  await waitUntil('the plan change to reach the account store', 20_000, async () => (await act('billing.get', { accountId: second.accountId })).plan === 'starter' || null)
  const more = await waitUntil('the new newsletter limit to apply', 20_000, async () => {
    const r = await call(base, second.jar, 'POST', '/api/actions/newsletters.create', { name: 'Second one' })
    return r.status === 200 ? await r.json() : null
  })
  expect(more.id !== first.id, 'the starter plan allows a second newsletter')
  expect((await fetch(`${base}/hooks/test`, { method: 'POST', body: 'not json' })).status === 400, 'a malformed billing webhook is refused')
  state.set('secondNewsletter', first)
}
