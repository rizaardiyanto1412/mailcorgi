import { z } from 'zod'
import type { SmokeContext } from '../../smoke-context.ts'
import { Jar, call, waitUntil } from '../../smoke-context.ts'

/** The second account sends an issue; the admin blocks it and sending stops; unblocking restores it. */
export default async function step({ base, action, expect, state }: SmokeContext) {
  const second = z.object({ jar: z.instanceof(Jar), accountId: z.string() }).parse(state.get('second'))
  const newsletter = z.object({ id: z.string() }).parse(state.get('secondNewsletter'))
  const act = async (name: string, input: unknown = {}, status = 200) => {
    const r = await call(base, second.jar, 'POST', `/api/actions/${name}`, input)
    const data = await r.json().catch(() => null)
    expect(r.status === status, `${name} as the second owner answered ${r.status}: ${JSON.stringify(data)}`)
    return data
  }
  const domain = await act('domains.add', { name: 'smoke.example.com' })
  expect((await act('domains.check', { domainId: domain.id })).status === 'verified', 'the second account verifies its sending domain')
  await act('newsletters.update', { newsletterId: newsletter.id, fromName: 'Second', fromLocal: 'hello', domainId: domain.id, postalAddress: '2 Example Street' })
  for (let i = 0; i < 3; i++) expect((await act('contacts.create', { newsletterId: newsletter.id, email: `cloud${i}@example.com` })).outcome === 'subscribed', `contact ${i} added`)
  const issue = async (subject: string) => {
    const draft = await act('campaigns.create', { newsletterId: newsletter.id, subject, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello from the cloud.' }] }] } })
    await act('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'Cloud preview' })
    return draft
  }
  const first = await issue('Cloud issue one')
  expect((await act('campaigns.send', { campaignId: first.id })).planned === 3, 'the paid account sends to its three contacts')
  await waitUntil('the cloud send to finish', 60_000, async () => (await act('campaigns.progress', { campaignId: first.id })).status === 'sent' || null)
  const blocked = await action('admin.block', { accountId: second.accountId, reason: 'Smoke: blocked on purpose' })
  expect(blocked.ok === true, 'the admin blocks the account')
  const draft = await issue('Cloud issue two')
  // The block travels to the account store through a job; the owner's bell shows when it has landed.
  await waitUntil('the block to reach the account', 20_000, async () => (await act('notifications.list')).items.some((n: { kind: string }) => n.kind === 'account_blocked') || null)
  const refusal = await act('campaigns.send', { campaignId: draft.id }, 403)
  expect(refusal.code === 'account_blocked', `a blocked account cannot send (${refusal.code})`)
  const test = await call(base, second.jar, 'POST', '/api/actions/campaigns.sendTest', { campaignId: draft.id, to: ['smoke@example.com'] })
  expect(test.status === 403, 'a blocked account cannot send a test email either')
  expect((await act('campaigns.get', { campaignId: draft.id })).status === 'draft', 'the refused issue is still a draft')
  const summary = await action('admin.accountSummary', { accountId: second.accountId })
  expect(summary.status === 'blocked' && summary.summary.contacts === 3, 'the admin summary shows the block and the list size')
  const alerts = await action('admin.alerts', {})
  expect(alerts.some((a: { kind: string }) => a.kind === 'account_blocked'), 'blocking raises an admin alert')
  await action('admin.unblock', { accountId: second.accountId })
  await waitUntil('the unblock to reach the account', 20_000, async () => (await call(base, second.jar, 'POST', '/api/actions/campaigns.sendTest', { campaignId: draft.id, to: ['smoke@example.com'] })).status === 200 || null)
  const resumed = await act('campaigns.send', { campaignId: draft.id })
  expect(resumed.planned === 3, 'sending works again after the unblock')
  await waitUntil('the second cloud send to finish', 60_000, async () => (await act('campaigns.progress', { campaignId: draft.id })).status === 'sent' || null)
  await call(base, second.jar, 'POST', '/api/auth/signout', {})
}
