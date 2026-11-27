import { campaignDoc, renderEmail, safeUrl, type DocNode } from '../render/index.ts'

export interface ReviewCheck {
  id: string
  level: 'error' | 'warning'
  message: string
}
export function reviewChecks(input: {
  campaign: Record<string, unknown>
  newsletter: Record<string, unknown>
  theme: Record<string, unknown>
  domainVerified: boolean
  /** Set only for a transactional welcome email (`transactionalWelcome`): it carries no visible unsubscribe link, so raw HTML is not asked for one. */
  transactional?: { headers: boolean }
}): ReviewCheck[] {
  const { campaign, newsletter } = input
  const checks: ReviewCheck[] = []
  const add = (id: string, level: ReviewCheck['level'], message: string) => checks.push({ id, level, message })
  const subject = typeof campaign.subject === 'string' ? campaign.subject.trim() : ''
  if (!subject) add('subject', 'error', 'Add a subject.')
  else if (subject.length > 150) add('subject_length', 'error', 'Keep the subject under 150 characters.')
  const plain = campaign.sendFormat === 'plain'
  if (!plain && !(campaign.previewText || campaign.preview_text)) add('preview_text', 'warning', 'Add preview text for the inbox.')
  if (!(newsletter.postalAddress || newsletter.postal_address)) add('postal_address', 'error', 'Add a postal address in newsletter settings.')
  if (!input.domainVerified) add('sender_domain', 'error', 'Choose a verified sender domain in newsletter settings.')
  const html = typeof campaign.html === 'string' && campaign.html ? campaign.html : typeof campaign.source === 'string' ? campaign.source : ''
  if (!plain && !input.transactional && campaign.format === 'html' && !/href\s*=\s*["'][^"']*\{\{\s*unsubscribe_url\s*\}\}/i.test(html)) add('unsubscribe', 'error', 'Include a link to {{unsubscribe_url}} in your HTML.')
  let missingAlt = false
  let invalidLink = false
  const checkLink = (url: unknown) => {
    if (typeof url === 'string' && url && !/^\{\{(unsubscribe_url|web_url|preferences_url)\}\}$/.test(url) && !safeUrl(url)) invalidLink = true
  }
  const visit = (node: DocNode) => {
    if (node.type === 'image') {
      if (!node.attrs?.alt || !String(node.attrs.alt).trim()) missingAlt = true
      checkLink(node.attrs?.href)
    }
    if (node.type === 'button') checkLink(node.attrs?.href)
    if (node.type === 'embed') checkLink(node.attrs?.url)
    for (const mark of node.marks ?? []) if (mark.type === 'link') checkLink(mark.attrs?.href)
    node.content?.forEach(visit)
  }
  if (campaign.format !== 'html') visit(campaignDoc(campaign))
  else {
    for (const image of html.matchAll(/<img\b[^>]*>/gi)) if (!/\balt\s*=\s*["'][^"']+['"]/i.test(image[0])) missingAlt = true
    for (const link of html.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)) checkLink(link[1])
  }
  if (missingAlt) add('image_alt', 'warning', 'Add alt text to every image.')
  if (invalidLink) add('links', 'error', 'Use an http or https address for every link.')
  const rendered = renderEmail({ campaign, newsletter, theme: input.theme, transactional: input.transactional, recipient: { contact: {}, links: { unsubscribe: 'https://example.com/unsubscribe', preferences: 'https://example.com/preferences', web: 'https://example.com/issue' } } })
  if (new TextEncoder().encode(rendered.html).length >= 102 * 1024) add('email_size', 'warning', 'This issue exceeds 102 KB. Gmail may clip it.')
  return checks
}
