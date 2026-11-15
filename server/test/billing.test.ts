import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Install } from './harness.ts'
import { fromBase64, hmac, toBase64, toBytes, toHex } from '../core/crypto.ts'
import { getPolicy } from '../account/usage/index.ts'
import { GRACE_MS, BLOCK_CANCEL_MS } from '../control/billing/index.ts'
import { plans } from '../control/billing/plans.ts'
import type { ProviderName } from '../control/billing/provider.ts'

const stripeSecret = 'test-only-stripe-signature'
const polarSecret = `whsec_${toBase64(toBytes('test-only-polar-signature-key'))}`
const products = { starter_monthly: '00000000-0000-4000-8000-000000000001', growth_yearly: '00000000-0000-4000-8000-000000000002' }
async function signed(install: Install, provider: ProviderName, event: unknown, id: string, timestamp = Math.floor(install.clock.now() / 1000), legacy = false) {
  const body = JSON.stringify(event)
  const sig = toBase64(await hmac(legacy ? toBytes(polarSecret) : fromBase64(polarSecret.slice(6)), `${id}.${timestamp}.${body}`))
  const headers: Record<string, string> = provider === 'stripe'
    ? { 'stripe-signature': `t=${timestamp},v1=${toHex(await hmac(toBytes(stripeSecret), `${timestamp}.${body}`))}` }
    : { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${sig}` }
  return { method: 'POST', headers, body }
}
function eventFor(install: Install, provider: ProviderName, accountId: string, id: string, plan: 'starter' | 'growth', status = 'active') {
  const end = install.clock.now() + 60_000
  if (provider === 'stripe') return { id, type: status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', created: Math.floor(install.clock.now() / 1000), data: { object: { id: 'sub_test', customer: 'cus_test', status, metadata: { accountId }, items: { data: [{ id: 'si_test', current_period_end: end / 1000, price: { id: `price_${plan}`, lookup_key: plans[plan].lookupKeys[plan === 'growth' ? 'yearly' : 'monthly'] } }] } } } }
  return { type: status === 'canceled' ? 'subscription.revoked' : status === 'past_due' ? 'subscription.past_due' : 'subscription.active', timestamp: new Date(install.clock.now()).toISOString(), data: { id: 'sub_test', customer_id: 'cus_test', product_id: products[plan === 'growth' ? 'growth_yearly' : 'starter_monthly'], status, current_period_end: new Date(end).toISOString(), customer: { external_id: accountId } } }
}
async function fixture(provider: ProviderName) {
  const install = await createInstall({ cloud: true, env: { ADMIN_EMAILS: 'admin@example.com', BILLING_PROVIDER: provider, STRIPE_SECRET_KEY: 'test-only-key', STRIPE_WEBHOOK_SECRET: stripeSecret, POLAR_ACCESS_TOKEN: 'test-only-token', POLAR_WEBHOOK_SECRET: polarSecret, POLAR_PRODUCTS: JSON.stringify(products) } })
  const owner = await install.signUp({ email: 'owner@example.com' })
  const calls: { method: string; path: string; body: string }[] = []
  let stripeStatus = 'active'
  let polarPaused = false
  install.app.control.ctx.platform.fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = String(init?.body ?? '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith('/prices')) {
      const lookup = url.searchParams.get('lookup_keys[]')
      return Response.json({ data: [{ id: lookup?.includes('growth') ? 'price_growth' : 'price_starter' }] })
    }
    if (url.pathname.endsWith('/subscriptions/sub_test') && method === 'GET') return Response.json(provider === 'stripe'
      ? { id: 'sub_test', status: stripeStatus, customer: 'cus_test', metadata: { accountId: owner.accountId }, items: { data: [{ id: 'si_test', price: { id: 'price_growth', lookup_key: plans.growth.lookupKeys.yearly } }] } }
      : { status: 'active', pause_at_period_end: polarPaused })
    if (url.pathname.includes('/checkout')) return Response.json({ url: 'https://checkout.example.com/session' })
    if (url.pathname.includes('billing_portal')) return Response.json({ url: 'https://billing.example.com/portal' })
    if (url.pathname.includes('customer-sessions')) return Response.json({ customer_portal_url: 'https://billing.example.com/portal' })
    if (provider === 'polar' && method === 'PATCH') polarPaused = JSON.parse(body).pause_at_period_end ?? polarPaused
    return Response.json({ id: 'sub_test' })
  }
  return { install, owner, calls, setStripeStatus: (status: string) => { stripeStatus = status } }
}
for (const provider of ['stripe', 'polar'] satisfies ProviderName[]) {
  test(`${provider}: valid, tampered, stale and replayed webhooks; full billing lifecycle`, async (t) => {
    const { install, owner, calls, setStripeStatus } = await fixture(provider)
    t.after(() => install.close())
    const accountId = owner.accountId!
    const other = await install.signUp({ email: 'other@example.com' })
    assert.equal((await expectError(() => other.action('billing.get', { accountId }))).status, 404)
    assert.equal((await expectError(() => other.action('billing.checkout', { accountId, plan: 'starter', interval: 'monthly' }))).status, 404)
    assert.equal((await owner.action('billing.checkout', { accountId, plan: 'starter', interval: 'monthly' })).url, 'https://checkout.example.com/session')
    const checkout = calls.find((c) => c.path.includes('checkout'))!
    if (provider === 'stripe') {
      const form = new URLSearchParams(checkout.body)
      assert.equal(form.get('line_items[0][price]'), 'price_starter')
      assert.equal(form.get('subscription_data[metadata][accountId]'), accountId)
    } else assert.deepEqual(JSON.parse(checkout.body).products, [products.starter_monthly])
    const event = eventFor(install, provider, accountId, 'evt_active', 'starter')
    const valid = await signed(install, provider, event, 'evt_active')
    const tampered = await install.fetch(`/hooks/${provider}`, { ...valid, body: valid.body + ' ' })
    assert.equal(tampered.status, 400)
    assert.equal((await install.fetch(`/hooks/${provider}`, await signed(install, provider, event, 'evt_active', Math.floor(install.clock.now() / 1000) - 301))).status, 400)
    assert.equal((await owner.action('billing.get', { accountId })).plan, 'free')
    const applied = await install.fetch(`/hooks/${provider}`, valid)
    assert.equal(applied.status, 200)
    assert.equal((await applied.json()).applied, 1)
    assert.equal(getPolicy(install.app.account(accountId).ctx).plan, 'free')
    await install.runJobs()
    const policy = getPolicy(install.app.account(accountId).ctx)
    assert.equal(policy.plan, 'starter')
    assert.equal(policy.limits.maxContacts, 5000)
    assert.equal((await (await install.fetch(`/hooks/${provider}`, valid)).json()).applied, 0)
    await install.runJobs()
    assert.equal(getPolicy(install.app.account(accountId).ctx).version, policy.version)
    assert.equal((await owner.action('billing.portal', { accountId })).url, 'https://billing.example.com/portal')
    await owner.action('billing.changePlan', { accountId, plan: 'growth', interval: 'yearly' })
    const change = calls.find((c) => c.path.endsWith('/subscriptions/sub_test') && c.method === (provider === 'stripe' ? 'POST' : 'PATCH'))!
    if (provider === 'stripe') assert.equal(new URLSearchParams(change.body).get('items[0][price]'), 'price_growth')
    else assert.equal(JSON.parse(change.body).product_id, products.growth_yearly)
    install.clock.advance(1000)
    assert.equal((await install.fetch(`/hooks/${provider}`, await signed(install, provider, eventFor(install, provider, accountId, 'evt_upgrade', 'growth'), 'evt_upgrade'))).status, 200)
    await install.runJobs()
    assert.equal(getPolicy(install.app.account(accountId).ctx).plan, 'growth')
    install.clock.advance(1000)
    setStripeStatus('past_due')
    const failure = provider === 'stripe' ? { id: 'evt_failed', type: 'invoice.payment_failed', created: install.clock.now() / 1000, data: { object: { parent: { subscription_details: { subscription: 'sub_test' } } } } } : eventFor(install, provider, accountId, 'evt_failed', 'growth', 'past_due')
    assert.equal((await install.fetch(`/hooks/${provider}`, await signed(install, provider, failure, 'evt_failed'))).status, 200)
    const pastDue = await owner.action('billing.get', { accountId })
    assert.equal(pastDue.status, 'past_due')
    assert.equal(pastDue.plan, 'growth')
    assert.equal(pastDue.graceUntil, install.clock.now() + GRACE_MS)
    install.clock.advance(1000)
    await owner.action('billing.cancel', { accountId })
    const canceled = eventFor(install, provider, accountId, 'evt_canceled', 'growth', 'canceled')
    assert.equal((await install.fetch(`/hooks/${provider}`, await signed(install, provider, canceled, 'evt_canceled'))).status, 200)
    install.clock.advance(GRACE_MS + 60_000)
    await install.runJobs()
    assert.equal((await owner.action('billing.get', { accountId })).plan, 'free')
    assert.equal(getPolicy(install.app.account(accountId).ctx).limits.maxContacts, plans.free.maxContacts)
    assert.equal((await (await install.fetch(`/hooks/${provider}`, await signed(install, provider, { ...event, ...(provider === 'stripe' ? { id: 'evt_late' } : {}) }, 'evt_late'))).json()).applied, 1)
    assert.equal((await owner.action('billing.get', { accountId })).plan, 'free', 'late old events cannot restore paid limits')
  })
  test(`${provider}: block policy is pushed, old versions ignored, billing pauses and resumes`, async (t) => {
    const { install, owner, calls } = await fixture(provider)
    t.after(() => install.close())
    const admin = await install.signUp({ email: 'admin@example.com' })
    const accountId = owner.accountId!
    const event = eventFor(install, provider, accountId, 'evt_paid', 'starter')
    await install.fetch(`/hooks/${provider}`, await signed(install, provider, event, 'evt_paid'))
    await install.runJobs()
    const before = getPolicy(install.app.account(accountId).ctx)
    assert.equal((await expectError(() => owner.action('admin.block', { accountId, reason: 'Abuse report' }))).status, 403)
    await admin.action('admin.block', { accountId, reason: 'Abuse report' })
    await install.runJobs()
    assert.equal(getPolicy(install.app.account(accountId).ctx).status, 'blocked', 'the policy copy read by each send batch stops sending')
    assert.equal((await install.app.stores.account(accountId).applyPolicy(before)).applied, false)
    const pause = calls.find((c) => c.body.includes(provider === 'stripe' ? 'pause_collection' : 'pause_at_period_end'))
    assert.ok(pause)
    await admin.action('admin.unblock', { accountId })
    await install.runJobs()
    assert.equal(getPolicy(install.app.account(accountId).ctx).status, 'active')
    assert.ok(calls.some((c) => c.body.includes(provider === 'stripe' ? 'pause_collection=' : '"pause_at_period_end":false')))
    await admin.action('admin.block', { accountId, reason: 'Blocked again' })
    await install.runJobs()
    install.clock.advance(BLOCK_CANCEL_MS)
    await install.runJobs()
    const refreshedOwner = await install.signIn(owner.email, 'correct horse battery')
    assert.equal((await refreshedOwner.action('billing.get', { accountId })).plan, 'free')
    assert.equal((await refreshedOwner.action('billing.get', { accountId })).hasSubscription, false)
    assert.ok(calls.some((c) => provider === 'stripe' ? c.method === 'DELETE' : c.body.includes('"revoke":true')))
  })
}
test('Polar supports legacy signing keys and multiple rotated signatures', async (t) => {
  const { install, owner } = await fixture('polar')
  t.after(() => install.close())
  const request = await signed(install, 'polar', eventFor(install, 'polar', owner.accountId!, 'evt_legacy', 'starter'), 'evt_legacy', undefined, true)
  request.headers['webhook-signature'] = `v1,invalid ${request.headers['webhook-signature']}`
  assert.equal((await install.fetch('/hooks/polar', request)).status, 200)
})
test('self-hosted has no billing endpoints or plan limits and still has admin', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  assert.equal((await expectError(() => owner.action('billing.get', { accountId: owner.accountId! }))).status, 404)
  for (const provider of ['stripe', 'polar']) assert.equal((await install.fetch(`/hooks/${provider}`, { method: 'POST', body: '{}' })).status, 404)
  assert.ok(Object.values(getPolicy(install.app.account(owner.accountId!).ctx).limits).every((v) => v === null))
  assert.equal((await owner.action('admin.accounts', {})).length, 1)
})

test('payment recovery cancels expiry, signed malformed input is rejected, and limits link to billing', async (t) => {
  const { install, owner } = await fixture('stripe')
  t.after(() => install.close())
  const accountId = owner.accountId!
  await owner.action('newsletters.create', { name: 'Free newsletter' })
  const limit = await expectError(() => owner.action('newsletters.create', { name: 'Over limit' }))
  assert.deepEqual(limit.details, { resource: 'newsletters', used: 1, limit: 1, billingUrl: '/settings/billing' })
  for (const [id, status] of [['evt_active', 'active'], ['evt_failed', 'past_due'], ['evt_recovered', 'active']]) {
    install.clock.advance(1000)
    await install.fetch('/hooks/stripe', await signed(install, 'stripe', eventFor(install, 'stripe', accountId, id!, 'growth', status), id!))
    await install.runJobs()
  }
  install.clock.advance(GRACE_MS + 1)
  await install.runJobs()
  assert.equal((await owner.action('billing.get', { accountId })).plan, 'growth')
  assert.equal((await owner.action('billing.get', { accountId })).graceUntil, null)
  assert.equal((await install.fetch('/hooks/stripe', await signed(install, 'stripe', { type: 'broken' }, 'evt_malformed'))).status, 400)
})

test('account deletion waits for provider cancellation and can retry it', async (t) => {
  const { install, owner } = await fixture('stripe')
  t.after(() => install.close())
  const accountId = owner.accountId!
  await install.fetch('/hooks/stripe', await signed(install, 'stripe', eventFor(install, 'stripe', accountId, 'evt_active', 'starter'), 'evt_active'))
  const fetchProvider = install.app.control.ctx.platform.fetch
  install.app.control.ctx.platform.fetch = async () => Response.json({ error: 'Synthetic outage' }, { status: 503 })
  await owner.action('account.delete', { accountId, confirmation: 'DELETE', currentPassword: 'correct horse battery' })
  await install.runJobs()
  assert.ok(install.app.control.ctx.db.get('SELECT id FROM accounts WHERE id = ?', accountId))
  install.app.control.ctx.platform.fetch = fetchProvider
  install.clock.advance(60_000)
  await install.runJobs()
  assert.equal(install.app.control.ctx.db.get('SELECT id FROM accounts WHERE id = ?', accountId), undefined)
  assert.equal((await owner.actionRaw('account.profile', {})).status, 401)
})
