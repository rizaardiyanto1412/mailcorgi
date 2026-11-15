import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ base, json, expect, state }: SmokeContext) {
  const newsletter = state.get('newsletter')
  if (!newsletter || typeof newsletter !== 'object' || !('id' in newsletter) || typeof newsletter.id !== 'string') throw new Error('Hygiene smoke needs a newsletter')
  const newsletterId = newsletter.id
  const settings = await json('POST', '/api/actions/hygiene.settings', { newsletterId })
  expect(settings.enabled === true && settings.afterIssues === 8 && settings.waitDays === 14, 'hygiene defaults are safe')
  const saved = await json('POST', '/api/actions/hygiene.updateSettings', { newsletterId, ...settings, afterIssues: 10, strict: true })
  expect(saved.afterIssues === 10 && saved.strict === true, 'hygiene settings save')
  const health = await json('POST', '/api/actions/hygiene.health', { newsletterId })
  expect(Array.isArray(health.statuses) && health.rates.bounceLimit === 0.05 && health.rates.complaintLimit === 0.003, 'list health exposes reputation limits')
  for (const path of ['/list-health', '/settings/hygiene']) {
    const response = await fetch(base + path)
    expect(response.ok && (await response.text()).includes('<div id="root">'), `${path} loads the SPA`)
  }
}
