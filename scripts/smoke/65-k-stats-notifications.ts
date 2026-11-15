import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ json, call, expect, state }: SmokeContext) {
  const newsletter = state.get('newsletter')
  if (!newsletter || typeof newsletter !== 'object' || !('id' in newsletter) || typeof newsletter.id !== 'string') throw new Error('smoke: newsletter step must run first')
  const overview = await json('POST', '/api/actions/stats.overview', { newsletterId: newsletter.id, range: '7' })
  expect(overview.growth.length === 7 && Number.isFinite(overview.subscribers), 'overview returns daily growth and subscriber count')
  const campaign = await json('POST', '/api/actions/campaigns.create', { newsletterId: newsletter.id, subject: 'Stats smoke draft' })
  const report = await json('POST', '/api/actions/stats.report', { campaignId: campaign.id })
  expect(report.counts.sent === 0 && report.counts.openRate === 0 && report.timeline.length === 48, 'empty campaign has safe rates and a 48-hour timeline')
  const recipients = await json('POST', '/api/actions/stats.recipients', { campaignId: campaign.id })
  expect(recipients.items.length === 0 && recipients.next === null, 'empty campaign has no recipients')
  const exported = await json('POST', '/api/actions/stats.exportRecipients', { campaignId: campaign.id })
  expect(exported.csv.startsWith('Email,Status,') && exported.next === null, 'recipient CSV exports a header')
  const notifications = await json('POST', '/api/actions/notifications.list', {})
  expect(Number.isFinite(notifications.unread) && Array.isArray(notifications.items), 'notification bell loads')
  await json('POST', '/api/actions/notifications.markRead', { ids: notifications.items.map((item: { id: string }) => item.id) })
  for (const page of ['/', `/campaigns/${campaign.id}/report`, '/notifications']) {
    const response = await call('GET', page)
    expect(response.ok && (await response.text()).includes('id="root"'), `${page} serves the SPA`)
  }
  state.set('statsCampaign', campaign)
}
