import sanitizeHtml from 'sanitize-html'
import { escapeHtml as e, renderWeb, parseTheme, fontStacks, safeUrl } from '../render/index.ts'
import { serializeCampaign } from '../campaigns/index.ts'
import type { NewsletterRow } from '../newsletters/index.ts'
import { issueDate, issueSlug, type PublicIssue, type WebsiteSettings } from './model.ts'

export interface Author { id: string; name: string; slug: string; bio: string; avatar_key: string | null; links: string }
export interface Site { nl: NewsletterRow; options: WebsiteSettings; base: string; app: string; accountId: string; custom: boolean; nonce: string; turnstileKey: string }
export const xml = (value: string) => e([...value].filter((char) => { const n = char.codePointAt(0)!; return n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 65534 && n !== 65535 && (n < 55296 || n > 57343)) }).join(''))
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
export const issueUrl = (site: Site, issue: PublicIssue) => `${site.base}/${encodeURIComponent(issueSlug(issue))}`
export const imageUrl = (site: Site, key: string | null) => key ? `${site.app}/img/${site.accountId}/${encodeURIComponent(key)}` : ''
const absolute = (site: Site, url: string) => safeUrl(url.startsWith('/') ? new URL(url, site.app).href : url)
export function rendered(site: Site, issue: PublicIssue, author?: Author) {
  const campaign = issue.kind === 'campaign' ? serializeCampaign(issue.row) : { format: 'markdown', subject: issue.row.subject, source: issue.row.source }
  const output = renderWeb({ campaign, newsletter: { name: site.nl.name }, theme: parseTheme(site.nl.theme), author })
  const html = sanitizeHtml(output.html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'figure', 'figcaption']),
    allowedAttributes: { a: ['href', 'rel'], img: ['src', 'alt', 'width', 'height', 'loading'], ol: ['start'] },
    allowedSchemes: ['https', 'http'], allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'head'],
    transformTags: {
      h1: 'h2',
      img: (_tag, attrs) => ({ tagName: 'img', attribs: { src: absolute(site, attrs.src ?? ''), alt: attrs.alt ?? '', width: /^\d{1,4}$/.test(attrs.width ?? '') ? attrs.width : '600', height: /^\d{1,4}$/.test(attrs.height ?? '') ? attrs.height : '400', loading: 'lazy' } }),
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  })
  const firstImage = output.image || /<img\b[^>]*src="([^"]+)"/i.exec(html)?.[1]?.replace(/&amp;/g, '&')
  return { html, excerpt: output.excerpt, image: firstImage ? absolute(site, firstImage) : imageUrl(site, site.nl.logo_key) }
}
function analytics(site: Site) {
  const o = site.options
  const script = (src: string, attrs = '') => `<script defer nonce="${e(site.nonce)}" src="${e(src)}" ${attrs}></script>`
  return `${o.plausible ? script('https://plausible.io/js/script.js', `data-domain="${e(o.plausible)}"`) : ''}${o.fathom ? script('https://cdn.usefathom.com/script.js', `data-site="${e(o.fathom)}"`) : ''}${o.umami ? script('https://cloud.umami.is/script.js', `data-website-id="${e(o.umami)}"`) : ''}${o.ga4 ? script(`https://www.googletagmanager.com/gtag/js?id=${o.ga4}`) + `<script nonce="${e(site.nonce)}">window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',${json(o.ga4)},{storage:'none',client_id:crypto.randomUUID()});</script>` : ''}`
}
export function csp(site: Site) {
  return `default-src 'self'; img-src https: http: data:; style-src 'self' 'unsafe-inline'; script-src ${site.custom && (site.options.headCode || site.options.bodyCode) ? "https: 'unsafe-inline'" : `'nonce-${site.nonce}'`}; connect-src 'self' https:; frame-src https:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action ${new URL(site.app).origin}`
}
export function layout(site: Site, input: { title: string; description: string; canonical: string; body: string; image?: string; article?: Record<string, unknown>; noindex?: boolean }) {
  const t = parseTheme(site.nl.theme)
  const logo = imageUrl(site, site.nl.logo_key)
  const image = input.image || logo
  const icon = site.options.favicon || imageUrl(site, site.nl.icon_key)
  const social = Object.entries(site.options.socialLinks).map(([name, url]) => `<a href="${e(safeUrl(url))}" rel="noopener noreferrer">${e(name)}</a>`).join(' · ')
  return `<!doctype html><html lang="${e(site.nl.language || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${e(input.title)}</title><meta name="description" content="${e(input.description)}"><link rel="canonical" href="${e(input.canonical)}"><link rel="alternate" type="application/rss+xml" title="${e(site.nl.name)}" href="${e(site.base)}/feed.xml">${icon ? `<link rel="icon" href="${e(icon)}">` : ''}${!site.options.enabled || input.noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}<meta property="og:type" content="${input.article ? 'article' : 'website'}"><meta property="og:title" content="${e(input.title)}"><meta property="og:description" content="${e(input.description)}"><meta property="og:url" content="${e(input.canonical)}"><meta property="og:site_name" content="${e(site.nl.name)}"><meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${e(input.title)}"><meta name="twitter:description" content="${e(input.description)}">${image ? `<meta property="og:image" content="${e(image)}"><meta name="twitter:image" content="${e(image)}">` : ''}<script type="application/ld+json" nonce="${e(site.nonce)}">${json(input.article ?? { '@context': 'https://schema.org', '@type': 'WebSite', name: site.nl.name, description: input.description, url: site.base })}</script><style>
:root{color-scheme:light dark;--bg:${t.background};--surface:${t.surface};--text:${t.text};--muted:${t.muted};--accent:${t.accent};--button:${t.buttonColor};--button-text:${t.buttonText}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:18px/1.65 ${fontStacks[t.font]};overflow-wrap:anywhere}a{color:var(--accent);text-underline-offset:4px}a:hover{text-decoration-thickness:2px}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.wrap{width:min(100% - 32px,760px);margin:auto}header{padding:32px 0;border-bottom:1px solid var(--muted)}header a{font-weight:bold;text-decoration:none}header img{vertical-align:middle;margin-right:12px;width:48px;height:48px;object-fit:contain}main{padding:40px 0 64px;min-height:60vh}h1{font-size:clamp(2rem,6vw,3rem);line-height:1.15;letter-spacing:-.035em}h2{line-height:1.3}p{margin:1em 0}.muted,time{color:var(--muted);font-size:.875rem}.card,.signup{background:var(--surface);border:1px solid color-mix(in srgb,var(--muted) 30%,transparent);border-radius:16px;padding:24px;margin:24px 0}.card h2{margin-top:0}.featured{border-left:4px solid var(--accent)}form{display:flex;gap:10px;flex-wrap:wrap}label{display:block;font-size:14px}input{font:inherit;padding:10px 12px;border:1px solid var(--muted);border-radius:8px;max-width:100%;background:var(--surface);color:var(--text)}button{font:inherit;padding:10px 20px;border:0;border-radius:${t.buttonShape === 'pill' ? '40px' : t.buttonShape === 'square' ? '0' : '8px'};background:var(--button);color:var(--button-text);cursor:pointer}footer{border-top:1px solid var(--muted);padding:24px 0 48px}nav{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}img,table{max-width:100%}img{object-fit:contain;height:auto}table{width:100%}td{padding:0}pre{white-space:pre-wrap}.prose>table{background:transparent}.prose h1{font-size:1.5rem}.trap{position:absolute;left:-10000px}.skip{position:absolute;top:-100px}.skip:focus{top:8px}@media(prefers-color-scheme:dark){:root{--bg:#111827;--surface:#1f2937;--text:#f9fafb;--muted:#cbd5e1;--accent:#fdba74;--button:#fdba74;--button-text:#111827}}@media(max-width:480px){main{padding-top:24px}.card,.signup{padding:18px}form>div{width:100%}input{width:100%}}
</style>${analytics(site)}${site.turnstileKey ? `<script async defer nonce="${e(site.nonce)}" src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>` : ''}${site.custom ? site.options.headCode : ''}</head><body><a class="skip" href="#main">Skip to content</a><header><div class="wrap"><a href="${e(site.base)}">${logo ? `<img src="${e(logo)}" alt="${e(site.nl.name)} logo" width="48" height="48">` : ''}${e(site.nl.name)}</a></div></header><main id="main" class="wrap">${input.body}</main><footer><div class="wrap"><nav aria-label="Footer"><a href="${e(site.base)}">Home</a><a href="${e(site.base)}/feed.xml">RSS feed</a></nav>${social ? `<p>${social}</p>` : ''}<p class="muted">${e(t.footerText)}</p></div></footer>${site.custom ? site.options.bodyCode : ''}</body></html>`
}
export function signup(site: Site, formToken: string) {
  return `<section class="signup" aria-label="Subscribe"><h2>Get the next issue</h2><p>Join ${e(site.nl.name)}. Unsubscribe whenever you like.</p><form method="post" action="${e(site.app)}/api/public/subscribe/${e(site.nl.key)}"><div><label for="subscribe-email">Email address</label><input id="subscribe-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required maxlength="320"></div><div class="trap" aria-hidden="true"><label for="subscribe-website">Leave this empty</label><input id="subscribe-website" name="website" tabindex="-1" autocomplete="off"></div><input type="hidden" name="formToken" value="${e(formToken)}">${site.turnstileKey ? `<div class="cf-turnstile" data-sitekey="${e(site.turnstileKey)}"></div>` : ''}<button type="submit">Subscribe</button></form></section>`
}
export function issueCard(site: Site, issue: PublicIssue, featured = false) {
  return `<article class="card${featured ? ' featured' : ''}">${featured ? '<p class="muted">Featured issue</p>' : ''}<h2><a href="${e(issueUrl(site, issue))}">${e(issue.row.subject)}</a></h2><time datetime="${new Date(issueDate(issue)).toISOString()}">${new Date(issueDate(issue)).toISOString().slice(0, 10)}</time><p>${e(rendered(site, issue).excerpt)}</p></article>`
}
export function feed(site: Site, issues: PublicIssue[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(site.nl.name)}</title><link>${xml(site.base)}</link><description>${xml(site.nl.description)}</description><language>${xml(site.nl.language)}</language><atom:link href="${xml(site.base)}/feed.xml" rel="self" type="application/rss+xml"/>${issues.map((issue) => `<item><title>${xml(issue.row.subject)}</title><link>${xml(issueUrl(site, issue))}</link><guid isPermaLink="true">${xml(issueUrl(site, issue))}</guid><pubDate>${new Date(issueDate(issue)).toUTCString()}</pubDate><description>${xml(rendered(site, issue).excerpt)}</description><content:encoded>${xml(rendered(site, issue).html)}</content:encoded></item>`).join('')}</channel></rss>`
}
