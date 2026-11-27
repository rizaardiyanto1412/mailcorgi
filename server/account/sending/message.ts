import { keepIssuedAt } from '../hygiene/index.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { EmailMessage } from '../../email/index.ts'
import { parseJson } from '../../core/db.ts'
import { newId } from '../../core/ids.ts'
import { getNewsletterRow, transactionalWelcome, type NewsletterRow } from '../newsletters/index.ts'
import { parseTheme, renderEmail } from '../render/index.ts'
import { serializeCampaign, type CampaignRow } from '../campaigns/index.ts'
import { verifiedSenderFor } from '../domains/index.ts'
import { publicUrl, signToken } from '../tracking/index.ts'

export interface SendContext {
  campaign: ReturnType<typeof serializeCampaign>
  row: CampaignRow
  newsletter: NewsletterRow
  theme: Record<string, unknown>
  sender: { from: string; replyTo?: string }
  tracking: { opens: boolean; clicks: boolean }
  links: { id: string; url: string }[]
  webUrl: string
  unsubscribeMailbox: string
}

/** Everything one campaign needs for every recipient, read once per batch. Null when the newsletter cannot send. */
export function sendContext(ctx: StoreCtx, row: CampaignRow): SendContext | null {
  const newsletter = getNewsletterRow(ctx, row.newsletter_id)
  const sender = verifiedSenderFor(ctx, row.newsletter_id)
  if (!newsletter || !sender) return null
  const tracking = parseJson<{ opens?: boolean; clicks?: boolean }>(newsletter.tracking, {})
  const domain = /<[^@>]+@([^>]+)>$/.exec(sender.from)?.[1] ?? 'localhost'
  return {
    campaign: serializeCampaign(row), row, newsletter, theme: parseTheme(newsletter.theme), sender,
    tracking: { opens: tracking.opens !== false, clicks: tracking.clicks !== false },
    links: ctx.db.all<{ id: string; url: string }>('SELECT id, url FROM links WHERE campaign_id = ? ORDER BY position', row.id),
    webUrl: publicUrl(ctx, `/n/${newsletter.slug}/${row.slug || row.id}`),
    unsubscribeMailbox: `unsubscribe@${domain}`,
  }
}

/** Record every link the issue carries once, so click tokens can only point at them. */
export function recordLinks(ctx: StoreCtx, send: SendContext): void {
  if (send.links.length || send.campaign.sendFormat === 'plain') return
  const urls: string[] = []
  renderEmail({ campaign: send.campaign, newsletter: send.newsletter, theme: send.theme, recipient: { contact: {}, links: { unsubscribe: 'https://example.invalid/u', preferences: 'https://example.invalid/p', web: send.webUrl, wrap: (url) => { if (!urls.includes(url)) urls.push(url); return url } } } })
  ctx.db.tx(() => {
    urls.forEach((url, position) => ctx.db.run('INSERT OR IGNORE INTO links (id, campaign_id, url, position) VALUES (?, ?, ?, ?)', newId('lnk'), send.row.id, url, position))
  })
  send.links = ctx.db.all<{ id: string; url: string }>('SELECT id, url FROM links WHERE campaign_id = ? ORDER BY position', send.row.id)
}

export interface Recipient {
  deliveryId: number | null
  contact: { id: string; email: string; name: string; fields: string }
}

/** Render one email with its tracked links and the headers architecture 6 requires. */
export async function buildMessage(ctx: StoreCtx, send: SendContext, recipient: Recipient, subjectPrefix = ''): Promise<EmailMessage> {
  const { contact, deliveryId } = recipient
  const campaignId = send.row.id
  const unsubscribe = publicUrl(ctx, `/u/${await signToken(ctx, 'u', [contact.id, campaignId])}`)
  const preferences = publicUrl(ctx, `/u/${await signToken(ctx, 'p', [contact.id])}`)
  const wrapped = new Map<string, string>()
  const tracked = deliveryId !== null && send.campaign.sendFormat !== 'plain'
  if (tracked && send.tracking.clicks) for (const link of send.links) wrapped.set(link.url, publicUrl(ctx, `/t/c/${await signToken(ctx, 'c', [deliveryId, link.id])}`))
  const openPixel = tracked && send.tracking.opens ? publicUrl(ctx, `/t/o/${await signToken(ctx, 'o', [deliveryId])}`) : undefined
  const keep = send.row.kind === 'keep' ? publicUrl(ctx, `/keep/${await signToken(ctx, 'k', [contact.id, keepIssuedAt(ctx, campaignId, contact.id)])}`) : ''
  const campaign = keep ? { ...send.campaign, source: send.campaign.source.replaceAll('{{keep_url}}', keep) } : send.campaign
  // Set only for a test send of a transactional welcome email. Campaigns and sequence steps always get undefined.
  const transactional = transactionalWelcome(send.row.kind, send.newsletter)
  const rendered = renderEmail({ campaign, newsletter: send.newsletter, theme: send.theme, transactional, recipient: { contact: { name: contact.name, email: contact.email, fields: contact.fields }, links: { unsubscribe, preferences, web: send.webUrl, openPixel, wrap: (url) => wrapped.get(url) ?? url } } })
  const accountId = ctx.accountId!
  return {
    from: send.sender.from, to: contact.email, replyTo: send.sender.replyTo,
    subject: subjectPrefix + rendered.subject, html: rendered.html, text: rendered.text, ...(rendered.textOnly ? { textOnly: true } : {}),
    headers: {
      ...rendered.headers,
      ...(transactional?.headers === false ? {} : { 'List-Unsubscribe': `<mailto:${send.unsubscribeMailbox}?subject=unsubscribe>, <${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }),
      'Feedback-ID': `${campaignId}:${send.row.newsletter_id}:${accountId}:mailcorgi`,
      'X-MC-Account': accountId,
      ...(deliveryId !== null ? { 'X-MC-Delivery': String(deliveryId) } : {}),
    },
    meta: { accountId, deliveryId: deliveryId === null ? null : String(deliveryId), kind: 'campaign' },
    idempotencyKey: deliveryId === null ? `test:${campaignId}:${newId('out')}` : `${accountId}:${campaignId}:${deliveryId}`,
  }
}
