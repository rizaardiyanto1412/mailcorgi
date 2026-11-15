import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ base, json, call, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string(), slug: z.string() }).parse(state.get('newsletter'))
  const current = await json('POST', '/api/actions/website.get', { newsletterId: newsletter.id })
  expect(current.settings.enabled, 'website is enabled by default')
  await json('POST', '/api/actions/website.update', { newsletterId: newsletter.id, settings: { ...current.settings, seoTitle: 'Smoke archive', seoDescription: 'Stories for readers.' } })
  await json('POST', '/api/actions/campaigns.list', { newsletterId: newsletter.id, status: 'sent', limit: 100 })
  await json('POST', '/api/actions/authors.list', { newsletterId: newsletter.id })
  const author = await json('POST', '/api/actions/authors.create', { newsletterId: newsletter.id, name: 'Smoke Writer', slug: 'smoke-writer', bio: 'Newsletter author.' })
  await json('POST', '/api/actions/website.publishPost', { newsletterId: newsletter.id, subject: 'Smoke web post', slug: 'smoke-post', source: 'Hello **readers** & friends.', authorId: author.id })
  const host = await json('POST', '/api/actions/website.setHost', { newsletterId: newsletter.id, hostname: 'smoke-news.example.com' })
  expect(host.txt.value.includes('.w.'), 'host TXT record uses the website token purpose')
  const checked = await json('POST', '/api/actions/website.checkHost', { newsletterId: newsletter.id })
  expect(checked.verifiedAt === null, 'a hostname without verification records stays unverified')
  const page = `/n/${newsletter.slug}`
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await call('GET', page)).status === 200) { ready = true; break }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  expect(ready, 'newsletter directory sync exposes the website')
  for (const path of [page, `${page}/smoke-post`, `${page}/authors/smoke-writer`]) {
    const response = await call('GET', path)
    expect(response.status === 200, `${path} renders`)
    const html = await response.text()
    expect((html.match(/<h1\b/g) || []).length === 1, `${path} has one main heading`)
    expect(html.includes('rel="canonical"'), `${path} has a canonical URL`)
    expect(html.includes('name="description"'), `${path} has a description`)
  }
  for (const route of ['/website', '/settings/website']) {
    const spa = await call('GET', route)
    const html = await spa.text()
    expect(spa.status === 200 && html.includes('id="root"'), `${route} loads the dashboard shell`)
  }
  const issue = await call('GET', `${page}/smoke-post`)
  const etag = issue.headers.get('etag')
  expect(etag, 'published posts have ETags')
  const cached = await fetch(`${base}${page}/smoke-post`, { headers: { 'if-none-match': etag! } })
  expect(cached.status === 304, 'unchanged issue supports conditional requests')
  const feed = await call('GET', `${page}/feed.xml`)
  expect(feed.status === 200 && (await feed.text()).includes('<content:encoded>'), 'RSS includes full issue content')
  const sitemap = await call('GET', `${page}/sitemap.xml`)
  expect(sitemap.status === 200 && (await sitemap.text()).includes('/smoke-post'), 'sitemap includes published posts')
  expect((await call('GET', '/api/public/tls-check?domain=smoke-news.example.com')).status === 404, 'TLS check rejects an unverified hostname')
  await json('POST', '/api/actions/website.stats', { newsletterId: newsletter.id })
  console.log('smoke: website pages, dashboard routes, publishing, feeds, cache and host gate ok')
}
