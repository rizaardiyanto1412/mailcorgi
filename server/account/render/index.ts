import sanitizeHtml from 'sanitize-html'
import type { AccountRegistrar } from '../rpc.ts'
import { parseDoc, markdownToDoc, decodeText, type DocNode } from './doc.ts'
import { parseTheme, fontStacks, type Theme } from './theme.ts'
export { nodeSchema, markSchema, emptyDoc, parseDoc, markdownToDoc } from './doc.ts'
export type { DocNode, DocMark } from './doc.ts'
export { themeSchema, parseTheme, defaultTheme, themePresets, fontStacks } from './theme.ts'
export type { Theme } from './theme.ts'

export interface RecipientLinks {
  unsubscribe: string
  web: string
  preferences: string
  openPixel?: string
  wrap?(url: string): string
}
export interface RenderCampaign {
  format?: string
  subject?: string
  previewText?: string
  preview_text?: string
  doc?: unknown
  source?: string | null
  html?: string | null
  text?: string | null
}
export interface RenderNewsletter {
  name?: string
  postalAddress?: string
  postal_address?: string
}
export interface RenderContact {
  name?: string
  email?: string
  fields?: unknown
}
export interface RenderEmailInput {
  campaign: RenderCampaign
  newsletter: RenderNewsletter
  theme: Record<string, unknown>
  recipient: {
    contact: RenderContact
    links: RecipientLinks
  }
}
export interface RenderWebInput {
  campaign: RenderCampaign
  newsletter: RenderNewsletter
  theme: Record<string, unknown>
  author?: { name?: string }
}
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
const string = (v: unknown) => typeof v === 'string' ? v : ''
export function safeUrl(value: string, relative = false): string {
  if ([...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return ''
  if (relative && /^\/(?!\/)/.test(value)) return value
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}
function fields(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}
export function mergeFields(value: string, contact: RenderContact, links: RecipientLinks): string {
  const custom = fields(contact.fields)
  const name = string(contact.name)
  return value.replace(/\{\{\s*([\w.]+)(?:\|([^}]*))?\s*\}\}/g, (_match, key: string, fallback: string | undefined) => {
    const values: Record<string, unknown> = { name, first_name: name.trim().split(/\s+/)[0], email: contact.email, unsubscribe_url: links.unsubscribe, web_url: links.web, preferences_url: links.preferences }
    const v = key.startsWith('field.') ? custom[key.slice(6)] : values[key]
    return (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && String(v) !== '' ? String(v) : fallback?.trim() ?? ''
  })
}
interface Part {
  html: string
  text: string
}
interface RenderContext {
  theme: Theme
  tracking: boolean
  merge(value: string): string
  href(value: string): string
  footnote(url: string): string
}
function makeContext(theme: Theme, contact: RenderContact, links: RecipientLinks): {
  ctx: RenderContext
  notes: string[]
} {
  const notes: string[] = []
  const merge = (value: string) => mergeFields(value, contact, links)
  return {
    notes,
    ctx: {
      theme, merge, tracking: typeof links.wrap === 'function',
      href: (value) => {
        const url = safeUrl(merge(value), true)
        return url ? safeUrl(links.wrap?.(url) ?? url, true) : ''
      },
      footnote: (value) => {
        const url = safeUrl(merge(value), true)
        if (!url) return ''
        let index = notes.indexOf(url)
        if (index < 0) {
          index = notes.length
          notes.push(url)
        }
        return ` [${index + 1}]`
      },
    },
  }
}
const size = (v: unknown, fallback: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(max, Math.round(v))) : fallback
function renderNode(node: DocNode, ctx: RenderContext): Part {
  const { theme: t, merge } = ctx
  const attrs = node.attrs ?? {}
  const attr = (key: string) => string(attrs[key])
  const content = () => (node.content ?? []).map((child) => renderNode(child, ctx))
  const children = () => {
    const parts = content()
    return { html: parts.map((p) => p.html).join(''), text: parts.map((p) => p.text).join('') }
  }
  const link = (html: string, url: string) => {
    const href = ctx.href(url)
    return href ? `<a href="${escapeHtml(href)}" style="color:${t.accent};text-decoration:underline" rel="noopener noreferrer">${html}</a>` : html
  }
  switch (node.type) {
    case 'text': {
      let html = escapeHtml(merge(node.text ?? ''))
      let text = merge(node.text ?? '')
      for (const mark of node.marks ?? []) {
        switch (mark.type) {
          case 'bold': html = `<strong>${html}</strong>`
            break
          case 'italic': html = `<em>${html}</em>`
            break
          case 'underline': html = `<u>${html}</u>`
            break
          case 'strike': html = `<s>${html}</s>`
            break
          case 'code': html = `<code style="font-family:${fontStacks.mono};background:${t.background};padding:2px 4px">${html}</code>`
            break
          case 'highlight': html = `<mark style="background:#fef08a;color:#20242c">${html}</mark>`
            break
          case 'link': {
            const url = string(mark.attrs?.href)
            html = link(html, url)
            text += ctx.footnote(url)
            break
          }
        }
      }
      return { html, text }
    }
    case 'hardBreak': return { html: '<br>', text: '\n' }
    case 'doc': return children()
    case 'paragraph': {
      const p = children()
      return { html: `<p style="margin:0 0 18px;line-height:1.65">${p.html || '<br>'}</p>`, text: `${p.text}\n\n` }
    }
    case 'heading': {
      const p = children()
      const level = size(attrs.level, 2, 3)
      return { html: `<h${level} style="color:${t.text};font-size:${t.headingSizes[level - 1]}px;line-height:1.25;margin:24px 0 14px">${p.html}</h${level}>`, text: `${p.text}\n\n` }
    }
    case 'bulletList': case 'orderedList': {
      const tag = node.type === 'bulletList' ? 'ul' : 'ol'
      const parts = content()
      const start = size(attrs.start, 1, 100000)
      return { html: `<${tag}${tag === 'ol' ? ` start="${start}"` : ''} style="padding-left:24px;margin:0 0 18px">${parts.map((p) => p.html).join('')}</${tag}>`, text: parts.map((p, i) => `${tag === 'ol' ? `${start + i}.` : '-'} ${p.text.trim()}\n`).join('') + '\n' }
    }
    case 'listItem': {
      const p = children()
      return { html: `<li style="padding:3px 0">${p.html}</li>`, text: p.text }
    }
    case 'blockquote': {
      const p = children()
      return { html: `<blockquote style="margin:18px 0;padding:8px 18px;border-left:4px solid ${t.accent}">${p.html}</blockquote>`, text: p.text.trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' }
    }
    case 'codeBlock': {
      const p = children()
      return { html: `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:${t.background};color:${t.text};font-family:${fontStacks.mono}">${p.html}</pre>`, text: `${p.text}\n\n` }
    }
    case 'horizontalRule': case 'divider': return { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${t.muted};height:20px"></td></tr></table>`, text: '\n---\n\n' }
    case 'spacer': return { html: `<div style="height:${size(attrs.height, 24, 160)}px;line-height:1px" aria-hidden="true">&#160;</div>`, text: '\n' }
    case 'image': {
      const src = safeUrl(merge(attr('src')), true)
      const alt = merge(attr('alt'))
      const caption = merge(attr('caption'))
      if (!src) return { html: '', text: alt ? `[${alt}]\n\n` : '' }
      const image = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${size(attrs.width, 600, 1200)}"${attrs.height ? ` height="${size(attrs.height, 400, 4000)}"` : ''} style="display:block;max-width:100%;height:auto;border:0" loading="lazy">`
      return { html: `<figure style="margin:18px 0">${attr('href') ? link(image, attr('href')) : image}${caption ? `<figcaption style="font-size:13px;color:${t.muted};padding-top:8px">${escapeHtml(caption)}</figcaption>` : ''}</figure>`, text: `[${alt || 'Image'}]${attr('href') ? ctx.footnote(attr('href')) : ctx.footnote(attr('src'))}${caption ? ` ${caption}` : ''}\n\n` }
    }
    case 'button': {
      const label = merge(attr('label') || 'Read more')
      const href = ctx.href(attr('href'))
      const align = ['left', 'center', 'right'].includes(attr('align')) ? attr('align') : 'left'
      const radius = t.buttonShape === 'pill' ? 48 : t.buttonShape === 'rounded' ? 8 : 0
      return { html: href ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="${align}" style="padding:12px 0 24px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${t.buttonColor}" style="background:${t.buttonColor};border-radius:${radius}px;mso-padding-alt:14px 24px"><a href="${escapeHtml(href)}" style="display:inline-block;border:1px solid ${t.buttonColor};border-radius:${radius}px;padding:14px 24px;color:${t.buttonText};background:${t.buttonColor};text-decoration:none;font-weight:bold;mso-padding-alt:0">${escapeHtml(label)}</a></td></tr></table></td></tr></table>` : `<p>${escapeHtml(label)}</p>`, text: `${label}${ctx.footnote(attr('href'))}\n\n` }
    }
    case 'callout': {
      const p = children()
      const emoji = escapeHtml(merge(attr('emoji')))
      const tone = attr('tone')
      const border = tone === 'warning' ? '#854d0e' : tone === 'success' ? '#166534' : t.accent
      return { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:16px;background:${t.background};border-left:4px solid ${border}">${emoji ? `${emoji} ` : ''}${p.html}</td></tr></table>`, text: `${merge(attr('emoji'))} ${p.text}\n` }
    }
    case 'embed': {
      const title = merge(attr('title') || attr('url'))
      const description = merge(attr('description'))
      const image = safeUrl(merge(attr('image')), true)
      return { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:16px;border:1px solid ${t.muted}">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" width="120" style="max-width:100%;height:auto">` : ''}<p>${link(escapeHtml(title), attr('url'))}</p><p>${escapeHtml(description)}</p></td></tr></table>`, text: `${title}${ctx.footnote(attr('url'))}\n${description}\n\n` }
    }
  }
}
export function campaignDoc(campaign: RenderCampaign): DocNode {
  return campaign.format === 'markdown' ? markdownToDoc(string(campaign.source)) : parseDoc(campaign.doc)
}
const sanitise = (html: string) => sanitizeHtml(html, {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'hr', 'img', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'div', 'span', 'figure', 'figcaption', 'mark'],
  allowedAttributes: { a: ['href', 'title', 'rel'], img: ['src', 'alt', 'width', 'height'], ol: ['start'] },
  allowedSchemes: ['https', 'http'], allowProtocolRelative: false,
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }) },
})

function htmlText(html: string, ctx: RenderContext): string {
  const safe = sanitise(html)
  const annotated = safe.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) => `${label}${escapeHtml(ctx.footnote(decodeText(href)))}`)
  const plain = sanitizeHtml(annotated.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })
  return decodeText(plain).trim()
}
function body(campaign: RenderCampaign, ctx: RenderContext, web: boolean): Part {
  if (campaign.format === 'html') {
    const html = string(campaign.html) || string(campaign.source)
    const merged = html.replace(/\{\{[^}]*\}\}/g, (field) => escapeHtml(ctx.merge(field)))
    const tracked = !web && ctx.tracking ? merged.replace(/(<a\b[^>]*\bhref\s*=\s*)(["'])(.*?)\2/gi, (_match, prefix: string, quote: string, href: string) => `${prefix}${quote}${escapeHtml(ctx.href(decodeText(href)))}${quote}`) : merged
    return { html: web ? sanitise(merged) : tracked, text: string(campaign.text) ? ctx.merge(string(campaign.text)) : htmlText(merged, ctx) }
  }
  return renderNode(campaignDoc(campaign), ctx)
}
function page(content: string, theme: Theme, preview = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head><body style="margin:0;background:${theme.background};color:${theme.text};font-family:${fontStacks[theme.font]};font-size:16px">${preview ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preview)}</div>` : ''}<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${theme.background}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;background:${theme.surface};color:${theme.text}"><tr><td style="padding:28px;overflow-wrap:anywhere">${content}</td></tr></table></td></tr></table></body></html>`
}
function header(theme: Theme, newsletter: RenderNewsletter): string {
  const logo = safeUrl(theme.header.logo, true)
  return `${logo ? `<img src="${escapeHtml(logo)}" width="160" alt="${escapeHtml(string(newsletter.name))}" style="max-width:100%;height:auto;margin-bottom:20px">` : ''}${theme.header.title ? `<p style="font-weight:bold;color:${theme.accent}">${escapeHtml(theme.header.title)}</p>` : ''}`
}
export function renderEmail(input: RenderEmailInput): {
  subject: string
  html: string
  text: string
  headers: Record<string, string>
} {
  const theme = parseTheme(input.theme)
  const { ctx, notes } = makeContext(theme, input.recipient.contact, input.recipient.links)
  const part = body(input.campaign, ctx, false)
  const links = input.recipient.links
  const address = string(input.newsletter.postalAddress) || string(input.newsletter.postal_address)
  const footerLink = (url: string, label: string) => `<a href="${escapeHtml(safeUrl(url, true))}" style="color:${theme.accent}">${label}</a>`
  const footer = `<div style="margin-top:32px;border-top:1px solid ${theme.muted};padding-top:20px;font-size:13px;color:${theme.muted}"><p>${escapeHtml(ctx.merge(theme.footerText))}</p><p>${escapeHtml(address)}</p><p>${footerLink(links.unsubscribe, 'Unsubscribe')} · ${footerLink(links.preferences, 'Preferences')} · ${footerLink(links.web, 'View on the web')}</p></div>`
  const pixel = links.openPixel && safeUrl(links.openPixel, true)
  const html = page(header(theme, input.newsletter) + part.html + footer + (pixel ? `<img src="${escapeHtml(pixel)}" width="1" height="1" alt="" style="display:block;border:0">` : ''), theme, ctx.merge(string(input.campaign.previewText) || string(input.campaign.preview_text)))
  const text = `${part.text.trim()}${notes.length ? '\n\n' + notes.map((url, i) => `[${i + 1}] ${url}`).join('\n') : ''}\n\n${ctx.merge(theme.footerText)}\n${address}\nUnsubscribe: ${safeUrl(links.unsubscribe, true)}\nPreferences: ${safeUrl(links.preferences, true)}\nView on the web: ${safeUrl(links.web, true)}`
  return { subject: ctx.merge(string(input.campaign.subject)).replace(/[\r\n]/g, ' '), html, text, headers: { 'List-Unsubscribe': `<${safeUrl(links.unsubscribe)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }
}
export function renderWeb(input: RenderWebInput): {
  html: string
  excerpt: string
  image?: string
} {
  const theme = parseTheme(input.theme)
  const { ctx } = makeContext(theme, {}, { unsubscribe: '', preferences: '', web: '' })
  const part = body(input.campaign, ctx, true)
  const title = `<h1 style="font-size:${theme.headingSizes[0]}px">${escapeHtml(ctx.merge(string(input.campaign.subject)))}</h1>`
  const author = input.author ? `<p>${escapeHtml(string(input.author.name))}</p>` : ''
  const findImage = (node: DocNode): string | undefined => node.type === 'image' ? safeUrl(string(node.attrs?.src), true) || undefined : node.content?.map(findImage).find(Boolean)
  return { html: page(header(theme, input.newsletter) + title + author + part.html, theme), excerpt: part.text.replace(/\s+/g, ' ').trim().slice(0, 240), image: findImage(campaignDoc(input.campaign)) }
}
export function renderDocPreview(doc: unknown, theme: Record<string, unknown>): string {
  const parsed = parseTheme(theme)
  const { ctx } = makeContext(parsed, {}, { unsubscribe: '#', preferences: '#', web: '#' })
  return page(renderNode(parseDoc(doc), ctx).html, parsed)
}
export const renderModule = { name: 'render', register(_reg: AccountRegistrar) { } }
