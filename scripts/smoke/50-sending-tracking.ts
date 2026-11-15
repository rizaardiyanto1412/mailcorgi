import type { SmokeContext } from '../smoke-context.ts'

/** Sending needs a verified domain, which smoke cannot get without DNS, so this checks the guards and the public routes. */
export default async function step({ base, json, call, expect, state }: SmokeContext) {
  const newsletter = state.get('newsletter')
  if (!newsletter || typeof newsletter !== 'object' || !('id' in newsletter) || typeof newsletter.id !== 'string') throw new Error('smoke: newsletter step must run first')
  const draft = await json('POST', '/api/actions/campaigns.create', { newsletterId: newsletter.id, subject: 'Smoke issue' })
  const count = await json('POST', '/api/actions/campaigns.audienceCount', { campaignId: draft.id })
  expect(count.total === 0 && count.fresh === 0, 'an empty newsletter has an empty audience')
  const progress = await json('POST', '/api/actions/campaigns.progress', { campaignId: draft.id })
  expect(progress.status === 'draft' && progress.counts.planned === 0 && progress.steps.length === 0, 'progress reads a draft')
  const refused = await json('POST', '/api/actions/campaigns.send', { campaignId: draft.id }, 400)
  expect(refused.code === 'review_failed' && Array.isArray(refused.details?.checks), 'a send without a verified sender is refused with the review checks')
  const test = await json('POST', '/api/actions/campaigns.sendTest', { campaignId: draft.id, to: ['smoke@example.com'] }, 400)
  expect(test.code === 'sender_unverified', 'a test email needs a verified sender')
  const still = await json('POST', '/api/actions/campaigns.get', { campaignId: draft.id })
  expect(still.status === 'draft', 'a refused send leaves the draft untouched')
  const page = await call('GET', `/campaigns/${draft.id}`)
  expect(page.ok && (await page.text()).includes('id="root"'), 'the campaign page serves the SPA')
  const accountId = (await json('GET', '/api/auth/bootstrap')).session.current
  for (const path of [`/t/o/${accountId}.o.MQ.bad`, `/t/c/${accountId}.c.MQ.bad`, `/u/${accountId}.u.MQ.bad`, `/keep/${accountId}.k.MQ.bad`]) {
    const r = await fetch(base + path, { redirect: 'manual' })
    expect(path.startsWith('/t/o/') ? r.status === 200 && r.headers.get('content-type') === 'image/gif' : r.status === 404, `${path} with a tampered token answers ${r.status}`)
  }
  expect((await fetch(`${base}/u/${accountId}.u.MQ.bad`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status === 404, 'one-click unsubscribe with a bad token is a 404')
  state.set('campaign', draft)
}
