import type { SmokeContext } from '../smoke-context.ts'

/** Full journey, part 1: the test provider, a verified sending domain and a newsletter that sends from it. */
export default async function step({ action, expect, state }: SmokeContext) {
  const settings = await action('install.settings.get')
  expect(['', 'test'].includes(settings.values.email_provider), 'a fresh install uses the test provider')
  await action('install.settings.set', { values: { send_rate_per_second: '1000' } })
  const newsletter = await action('newsletters.create', { name: 'Journey Weekly' })
  expect(newsletter.slug === 'journey-weekly', 'the journey newsletter got its slug')
  const added = await action('domains.add', { name: 'smoke.example.com' })
  expect(added.status === 'pending' && added.records.some((r: { purpose: string }) => r.purpose === 'SPF'), 'a new domain is pending with SPF and DMARC records to add')
  const checked = await action('domains.check', { domainId: added.id })
  expect(checked.status === 'verified' && checked.records.every((r: { found: boolean }) => r.found), `the domain verifies through the canned DNS answers (${checked.status})`)
  expect((await action('domains.senders', { newsletterId: newsletter.id })).some((d: { id: string }) => d.id === added.id), 'the verified domain is offered as a sender')
  const updated = await action('newsletters.update', { newsletterId: newsletter.id, fromName: 'Journey', fromLocal: 'news', domainId: added.id, postalAddress: '1 Example Street, Example City' })
  expect(updated.domainId === added.id && updated.fromLocal === 'news', 'the newsletter sends from the verified domain')
  const checklist = await action('setup.checklist')
  expect(checklist.items.find((i: { id: string }) => i.id === 'domain')?.state === 'done', 'the setup checklist sees the verified domain')
  state.set('journey', newsletter)
  state.set('domain', added)
}
