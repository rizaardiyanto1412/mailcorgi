import type { Context } from 'hono'
import type { AccountRegistrar } from '../rpc.ts'
import type { StoreEnv } from '../../core/http.ts'
import { clientIp } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'
import { randomToken, sha256Hex } from '../../core/crypto.ts'
import { formToken } from '../signup/index.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { escapeHtml as e, safeUrl } from '../render/index.ts'
import { baseUrl, ensureAppUrl, issueDate, issueSlug, publicIssues, settings, websiteHost } from './model.ts'
import { csp, feed, imageUrl, issueCard, issueUrl, layout, rendered, signup, xml, type Author, type Site } from './templates.ts'
import { readPage, writePage, type CachedPage } from './cache.ts'

function countView(c: Context<StoreEnv>, newsletterId: string, campaignId: string | null) {
  const ctx = c.get('ctx')
  const req = c.req.raw
  if (req.method !== 'GET' || c.get('actor')?.owner || /bot|crawl|spider|slurp|preview|scanner|facebookexternalhit|headless|lighthouse|curl|wget/i.test(req.headers.get('user-agent') || '') || /prefetch|prerender/i.test(`${req.headers.get('purpose')} ${req.headers.get('sec-purpose')} ${req.headers.get('x-purpose')}`)) return
  let referrer = ''
  try { referrer = new URL(req.headers.get('referer') || '').hostname } catch { /* Missing referrers are direct visits. */ }
  const country = req.headers.get('cf-ipcountry') || ''
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO page_views (newsletter_id, campaign_id, path, referrer_host, country, at) VALUES (?, ?, ?, ?, ?, ?)', newsletterId, campaignId, new URL(req.url).pathname.slice(0, 2048), referrer, /^[A-Z]{2}$/.test(country) ? country : '', ctx.now())
    ctx.db.run('INSERT INTO daily_stats (newsletter_id, day, page_views) VALUES (?, ?, 1) ON CONFLICT(newsletter_id, day) DO UPDATE SET page_views = page_views + 1', newsletterId, new Date(ctx.now()).toISOString().slice(0, 10))
  })
}
export function registerRoutes(reg: AccountRegistrar) {
  reg.routes((app) => {
    app.on(['GET', 'HEAD'], '*', async (c, next) => {
      const id = c.req.header('x-mc-site')
      if (!id) return next()
      const ctx = c.get('ctx')
      const nl = getNewsletterRow(ctx, id)
      if (!nl || nl.archived_at !== null) return c.notFound()
      const url = new URL(c.req.url)
      const host = websiteHost(ctx, nl.id)
      const custom = !!c.req.header('x-mc-host') && host?.hostname === url.hostname && host.verified_at !== null
      if (c.req.header('x-mc-host') && !custom) return c.notFound()
      const prefix = custom ? '' : `/n/${nl.slug}`
      if (!custom && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return c.notFound()
      const path = url.pathname.slice(prefix.length).replace(/\/$/, '') || '/'
      if (!allowRate(ctx.db, `website:${clientIp(c)}`, 600, 60000, ctx.now())) return c.text('Too many requests. Try again shortly.', 429, { 'Retry-After': '60' })
      await ensureAppUrl(ctx)
      const origin = ctx.config.appUrl || url.origin
      const site: Site = { nl, options: settings(nl.website), base: baseUrl(ctx, nl.id, origin), app: origin, accountId: ctx.accountId!, custom, nonce: randomToken(16), turnstileKey: ctx.config.turnstile?.siteKey ?? '' }
      const notFound = () => {
        const body = layout(site, { title: `Page not found · ${nl.name}`, description: 'This page is unavailable.', canonical: site.base, noindex: true, body: `<h1>Page not found</h1><p>This page may have moved or is no longer public.</p><a href="${e(site.base)}">Back to home</a>` })
        return new Response(c.req.method === 'HEAD' ? null : body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp(site), 'x-robots-tag': 'noindex, nofollow' } })
      }
      const pageInput = url.searchParams.get('page') || '1'
      if (!/^\d{1,6}$/.test(pageInput) || Number(pageInput) < 1) return notFound()
      const page = Number(pageInput)
      const version = ctx.db.get<{ version: number }>('SELECT version FROM website_cache_versions WHERE newsletter_id = ?', nl.id)?.version ?? 0
      const key = new URL('/__mailcorgi_website_cache', origin)
      key.searchParams.set('key', `${ctx.accountId}:${nl.id}:${version}:${url.origin}:${path}:${page}:${Math.floor(ctx.now() / 300000)}`)
      const respond = (cached: CachedPage) => {
        if (cached.type.startsWith('text/html')) countView(c, nl.id, cached.campaignId)
        const headers = { 'Content-Type': cached.type, 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60', ETag: cached.etag, 'Content-Security-Policy': cached.csp, 'Cache-Tag': `website-${nl.id}-${version}`, 'X-Robots-Tag': site.options.enabled ? 'index, follow' : 'noindex, nofollow' }
        if (c.req.header('if-none-match')?.split(',').map((v) => v.trim().replace(/^W\//, '')).some((v) => v === cached.etag || v === '*')) return new Response(null, { status: 304, headers })
        return new Response(c.req.method === 'HEAD' ? null : cached.body, { headers })
      }
      const hit = await readPage(key.href, 'caches' in globalThis)
      if (hit) return respond(hit)
      const signupToken = await formToken(ctx, nl.id)
      const issues = site.options.enabled ? publicIssues(ctx, nl.id) : []
      const authors = ctx.db.all<Author>('SELECT * FROM authors WHERE newsletter_id = ? ORDER BY name', nl.id)
      let campaignId: string | null = null
      let type = 'text/html; charset=utf-8'
      let canonical = site.base
      let build: () => string
      if (path === '/feed.xml') {
        type = 'application/rss+xml; charset=utf-8'
        build = () => feed(site, issues.slice(0, 50))
      } else if (path === '/sitemap.xml') {
        type = 'application/xml; charset=utf-8'
        build = () => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${site.options.enabled ? `<url><loc>${xml(site.base)}</loc></url>` + issues.map((i) => `<url><loc>${xml(issueUrl(site, i))}</loc><lastmod>${new Date(i.row.updated_at).toISOString()}</lastmod></url>`).join('') + authors.map((a) => `<url><loc>${xml(site.base)}/authors/${xml(a.slug)}</loc></url>`).join('') : ''}</urlset>`
      } else if (path === '/robots.txt') {
        type = 'text/plain; charset=utf-8'
        build = () => `User-agent: *\n${site.options.enabled ? `Allow: ${prefix || '/'}\nSitemap: ${site.base}/sitemap.xml` : `Disallow: ${prefix || '/'}`}\n`
      } else if (!site.options.enabled) return notFound()
      else if (path === '/') {
        if ((page - 1) * 10 >= issues.length && page > 1) return notFound()
        canonical = site.base + (page > 1 ? `?page=${page}` : '')
        build = () => {
          const shown = issues.slice((page - 1) * 10, page * 10)
          const cards = shown.map((issue, i) => issueCard(site, issue, page === 1 && i === 0)).join('')
          const paging = `<nav aria-label="Archive pages">${page > 1 ? `<a rel="prev" href="${e(site.base)}${page > 2 ? `?page=${page - 1}` : ''}">Newer issues</a>` : '<span></span>'}${page * 10 < issues.length ? `<a rel="next" href="${e(site.base)}?page=${page + 1}">Older issues</a>` : ''}</nav>`
          return layout(site, { title: site.options.seoTitle || nl.name, description: site.options.seoDescription || nl.description, canonical, body: `<h1>${e(nl.name)}</h1><p>${e(nl.description)}</p>${signup(site, signupToken)}<section aria-label="Latest issues">${cards || '<h2>No issues yet</h2><p>Subscribe to receive the first issue.</p>'}</section>${paging}` })
        }
      } else if (path.startsWith('/authors/')) {
        const author = authors.find((a) => path === `/authors/${a.slug}`)
        if (!author) return notFound()
        const authored = issues.filter((i) => i.row.author_id === author.id)
        if (page > 1 && (page - 1) * 10 >= authored.length) return notFound()
        canonical = `${site.base}/authors/${author.slug}${page > 1 ? `?page=${page}` : ''}`
        build = () => layout(site, { title: `${author.name} · ${nl.name}`, description: author.bio || `Issues by ${author.name}`, canonical, body: `<h1>${e(author.name)}</h1>${author.avatar_key ? `<img src="${e(imageUrl(site, author.avatar_key))}" alt="${e(author.name)}" width="96" height="96">` : ''}<p>${e(author.bio)}</p>${Object.entries(zLinks(author.links)).map(([name, url]) => `<a href="${e(safeUrl(url))}" rel="noopener noreferrer">${e(name)}</a>`).join(' · ')}<section aria-label="Author issues">${authored.slice((page - 1) * 10, page * 10).map((i) => issueCard(site, i)).join('') || '<p>No published issues yet. Subscribe for new writing.</p>'}</section><nav aria-label="Author pages">${page > 1 ? `<a rel="prev" href="${e(site.base)}/authors/${e(author.slug)}?page=${page - 1}">Newer issues</a>` : ''}${page * 10 < authored.length ? `<a rel="next" href="${e(site.base)}/authors/${e(author.slug)}?page=${page + 1}">Older issues</a>` : ''}</nav>${signup(site, signupToken)}` })
      } else {
        const index = issues.findIndex((i) => path === `/${issueSlug(i)}`)
        const issue = issues[index]
        if (!issue) return notFound()
        campaignId = issue.kind === 'campaign' ? issue.row.id : null
        canonical = issueUrl(site, issue)
        build = () => {
          const author = authors.find((a) => a.id === issue.row.author_id)
          const content = rendered(site, issue)
          const iso = new Date(issueDate(issue)).toISOString()
          const article = { '@context': 'https://schema.org', '@type': 'Article', headline: issue.row.subject, description: content.excerpt, datePublished: iso, dateModified: new Date(issue.row.updated_at).toISOString(), url: canonical, image: content.image || undefined, author: author ? { '@type': 'Person', name: author.name, url: `${site.base}/authors/${author.slug}` } : { '@type': 'Organization', name: nl.name }, publisher: { '@type': 'Organization', name: nl.name, url: site.base }, mainEntityOfPage: canonical }
          const share = encodeURIComponent(canonical)
          return layout(site, { title: `${issue.row.subject} · ${nl.name}`, description: issue.kind === 'campaign' ? issue.row.preview_text || content.excerpt : content.excerpt, canonical, image: content.image, article, body: `<article><h1>${e(issue.row.subject)}</h1><p class="muted">${author ? `<a rel="author" href="${e(site.base)}/authors/${e(author.slug)}">${e(author.name)}</a> · ` : ''}<time datetime="${iso}">${iso.slice(0, 10)}</time></p><div class="prose">${content.html}</div></article><nav aria-label="Share this issue"><a href="https://twitter.com/intent/tweet?url=${share}&amp;text=${encodeURIComponent(issue.row.subject)}" rel="noopener noreferrer">Share on X</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${share}" rel="noopener noreferrer">Share on LinkedIn</a><a href="mailto:?subject=${encodeURIComponent(issue.row.subject)}&amp;body=${share}">Share by email</a></nav>${signup(site, signupToken)}<nav aria-label="More issues">${issues[index + 1] ? `<a rel="prev" href="${e(issueUrl(site, issues[index + 1]))}">Previous: ${e(issues[index + 1].row.subject)}</a>` : ''}${issues[index - 1] ? `<a rel="next" href="${e(issueUrl(site, issues[index - 1]))}">Next: ${e(issues[index - 1].row.subject)}</a>` : ''}</nav>` })
        }
      }
      const body = build()
      const cached = { body, type, etag: `"${await sha256Hex(body)}"`, csp: csp(site), campaignId }
      ctx.platform.waitUntil(writePage(key.href, cached, 'caches' in globalThis))
      return respond(cached)
    })
  })
}
function zLinks(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value)
  return parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
}
