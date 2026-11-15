import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'
import { sleep, waitUntil } from '../smoke-context.ts'
import { JOURNEY_CONTACTS, journeyEmail } from './46-journey-import.ts'

const LINK = 'https://example.com/journey-link'
const marks = (text: string, ...types: string[]) => ({ type: 'text', text, marks: types.map((type) => (type === 'link' ? { type, attrs: { href: LINK } } : { type })) })
/** Every node and mark type the render contract lists. */
export const everyNodeDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hello {{first_name|reader}}' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A second heading' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'A third heading' }] },
    { type: 'paragraph', content: [marks('bold ', 'bold'), marks('italic ', 'italic'), marks('underline ', 'underline'), marks('strike ', 'strike'), marks('code ', 'code'), marks('highlight ', 'highlight'), marks('a link', 'link'), { type: 'hardBreak' }, { type: 'text', text: 'after a break for {{email}} in {{field.city|nowhere}}' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first bullet' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second bullet' }] }] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first step' }] }] }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a quoted line' }] }] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1 < 2' }] },
    { type: 'horizontalRule' },
    { type: 'image', attrs: { src: 'https://example.com/picture.png', alt: 'A picture', width: 320, href: LINK, caption: 'The caption' } },
    { type: 'button', attrs: { label: 'Press me', href: LINK, align: 'center' } },
    { type: 'callout', attrs: { tone: 'info', emoji: '💡' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a callout' }] }] },
    { type: 'divider' },
    { type: 'spacer', attrs: { height: 24 } },
    { type: 'embed', attrs: { url: 'https://example.com/card', title: 'A link card', description: 'Card description', image: 'https://example.com/card.png' } },
    { type: 'paragraph', content: [{ type: 'text', text: 'Read on the web: {{web_url}} or manage {{preferences_url}}' }] },
  ],
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** Full journey, part 4: write, review, test, send to the segment, track, unsubscribe, provider events, report, website. */
export default async function step({ base, action, call, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string(), slug: z.string() }).parse(state.get('journey'))
  const segment = z.object({ id: z.string() }).parse(state.get('segment'))
  const draft = await action('campaigns.create', { newsletterId: newsletter.id, subject: 'Journey issue one', doc: everyNodeDoc, audience: { segmentId: segment.id } })
  const saved = await action('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'Every block in one issue' })
  expect(saved.revision > draft.revision, 'autosave bumps the revision')
  await action('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'stale' }, 409)
  const preview = await action('campaigns.preview', { campaignId: draft.id })
  const errors = preview.checks.filter((c: { level: string }) => c.level === 'error')
  expect(errors.length === 0, `the review passes (${JSON.stringify(errors)})`)
  expect(preview.email.html.includes('Press me') && preview.email.html.includes('a callout') && preview.email.html.includes('The caption') && preview.web.html.includes('Press me'), 'the email and web previews render every block')
  const audience = await action('campaigns.audienceCount', { campaignId: draft.id })
  expect(audience.total === JOURNEY_CONTACTS / 2 && audience.fresh === JOURNEY_CONTACTS / 2, `the audience is the segment (${audience.total})`)

  const test = await action('campaigns.sendTest', { campaignId: draft.id, to: ['smoke@example.com'] })
  expect(test.sent.length === 1 && test.failed.length === 0, 'the test email went out')
  const testMail = (await action('dev.outbox', { to: 'smoke@example.com' })).emails.at(-1)
  expect(testMail?.subject === '[Test] Journey issue one' && testMail.html.includes('Press me'), 'the test email landed in the outbox')

  const sent = await action('campaigns.send', { campaignId: draft.id })
  expect(sent.planned === JOURNEY_CONTACTS / 2 && sent.campaign.status === 'sending', `the send planned ${sent.planned} deliveries`)
  const progress = await waitUntil('the campaign to finish sending', 240_000, async () => {
    const p = await action('campaigns.progress', { campaignId: draft.id })
    if (p.status === 'paused') throw new Error(`smoke: the send paused: ${p.pauseMessage}`)
    return p.status === 'sent' ? p : null
  }, 500)
  expect(progress.counts.sent === JOURNEY_CONTACTS / 2 && progress.counts.queued === 0 && progress.counts.failed === 0, `every delivery was sent (${JSON.stringify(progress.counts)})`)
  const finished = await action('campaigns.get', { campaignId: draft.id })
  expect(finished.status === 'sent' && finished.sentAt, 'the campaign is marked sent')

  const reader = journeyEmail(0)
  const mail = (await action('dev.outbox', { to: reader })).emails.at(-1)
  expect(mail && mail.subject === 'Journey issue one', 'the first Paris reader got the issue')
  expect(mail.html.includes('Hello Reader<') && mail.html.includes('for journey0@example.com in Paris'), 'merge fields and custom fields were filled in')
  expect(!mail.html.includes('{{'), 'no merge field was left behind')
  const headers = mail.headers as Record<string, string>
  expect(headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && /<mailto:/.test(headers['List-Unsubscribe']) && headers['X-MC-Delivery'], 'every email carries one-click unsubscribe headers')
  const pixel = /https?:\/\/[^"'\s]+\/t\/o\/[A-Za-z0-9_.-]+/.exec(mail.html)?.[0]
  const click = /https?:\/\/[^"'\s]+\/t\/c\/[A-Za-z0-9_.-]+/.exec(mail.html)?.[0]
  const unsubscribe = /<(https?:\/\/[^>]+\/u\/[^>]+)>/.exec(headers['List-Unsubscribe'])?.[1]
  expect(pixel && click && unsubscribe, 'the email links to the open pixel, a tracked link and the unsubscribe page')
  await sleep(3500)
  const opened = await fetch(pixel!, { headers: { 'user-agent': UA } })
  expect(opened.status === 200 && opened.headers.get('content-type') === 'image/gif', 'the open pixel answers a gif')
  const clicked = await fetch(click!, { headers: { 'user-agent': UA }, redirect: 'manual' })
  expect(clicked.status === 302 && clicked.headers.get('location') === LINK, `the tracked link redirects to the recorded URL (${clicked.status} ${clicked.headers.get('location')})`)
  expect((await fetch(`${click}x`, { redirect: 'manual' })).status === 404, 'a tampered click token is refused')
  const page = await fetch(unsubscribe!)
  expect(page.status === 200 && /Unsubscribe\?/.test(await page.text()), 'the unsubscribe link shows a confirm page')
  const oneClick = await fetch(unsubscribe!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
  expect(oneClick.status === 200, `one-click unsubscribe answers ${oneClick.status}`)
  const after = await action('contacts.list', { newsletterId: newsletter.id, search: reader })
  expect(after.contacts[0]?.status === 'unsubscribed', 'the reader is unsubscribed')

  const recipients = await action('stats.recipients', { campaignId: draft.id, limit: 20 })
  expect(recipients.items.length === 20 && recipients.next && recipients.items.every((r: { status: string }) => r.status === 'sent'), 'recipient pages list sent deliveries')
  const deliveryOf = async (email: string) => {
    const sent = (await action('dev.outbox', { to: email })).emails.at(-1)
    return sent?.headers['X-MC-Delivery'] as string | undefined
  }
  const [bounced, complained, delivered] = [journeyEmail(2), journeyEmail(4), journeyEmail(6)]
  const ids = { bounced: await deliveryOf(bounced), complained: await deliveryOf(complained), delivered: await deliveryOf(delivered) }
  expect(ids.bounced && ids.complained && ids.delivered, 'every email names its delivery in X-MC-Delivery')
  const ingest = await action('dev.ingest', { events: [
    { id: 'smoke-bounce-1', type: 'bounce', bounce: { permanent: true, nonexistent: true, reason: 'Mailbox does not exist' }, deliveryId: ids.bounced, messageId: '', recipient: bounced },
    { id: 'smoke-complaint-1', type: 'complaint', deliveryId: ids.complained, messageId: '', recipient: complained },
    { id: 'smoke-delivered-1', type: 'delivered', deliveryId: ids.delivered, messageId: '', recipient: delivered },
    { id: 'smoke-delivered-1', type: 'delivered', deliveryId: ids.delivered, messageId: '', recipient: delivered },
  ] })
  expect(ingest.applied === 3, `three distinct provider events applied once each (${ingest.applied})`)
  expect((await action('contacts.list', { newsletterId: newsletter.id, search: bounced })).contacts[0]?.status === 'bounced', 'a hard bounce marks the contact bounced')
  expect((await action('contacts.list', { newsletterId: newsletter.id, search: complained })).contacts[0]?.status === 'complained', 'a complaint marks the contact complained')
  expect((await action('contacts.create', { newsletterId: newsletter.id, email: bounced })).outcome === 'suppressed', 'a bounced address stays suppressed')

  const report = await action('stats.report', { campaignId: draft.id })
  const c = report.counts
  expect(c.sent === JOURNEY_CONTACTS / 2 && c.opens === 1 && c.clicks === 1 && c.unsubscribes === 1 && c.bounces === 1 && c.complaints === 1 && c.delivered === 1, `the report counts match what happened (${JSON.stringify(c)})`)
  expect(report.links.some((l: { url: string; clicks: number }) => l.url === LINK && l.clicks === 1), 'the link table counts the click')
  const health = await action('hygiene.health', { newsletterId: newsletter.id })
  expect(health.statuses.some((s: { status: string; count: number }) => s.status === 'bounced' && s.count === 1), 'list health reflects the bounce')
  const engaged = await action('segments.count', { newsletterId: newsletter.id, filter: { field: 'engagement', op: 'openedLast', issues: 1 } })
  expect(engaged.count === 1, `the engagement filter sees the open (${engaged.count})`)

  const home = await waitUntil('the public website to list the issue', 20_000, async () => {
    const r = await call('GET', `/n/${newsletter.slug}`)
    const html = r.status === 200 ? await r.text() : ''
    return html.includes('Journey issue one') ? html : null
  })
  const issuePath = /href="([^"]*\/n\/journey-weekly\/[^"]+)"/.exec(home)?.[1]
  expect(issuePath, 'the home page links to the issue')
  const issue = await fetch(issuePath!.startsWith('http') ? issuePath! : base + issuePath)
  const issueHtml = await issue.text()
  expect(issue.status === 200 && issueHtml.includes('a callout') && !issueHtml.includes('/t/o/'), 'the web issue renders without tracking pixels')
  const feed = await call('GET', `/n/${newsletter.slug}/feed.xml`)
  expect(feed.status === 200 && (await feed.text()).includes('Journey issue one'), 'the feed carries the issue')
  const sitemap = await call('GET', `/n/${newsletter.slug}/sitemap.xml`)
  expect(sitemap.status === 200 && (await sitemap.text()).includes('/n/journey-weekly/'), 'the sitemap carries the issue')
  state.set('issue', finished)
}
