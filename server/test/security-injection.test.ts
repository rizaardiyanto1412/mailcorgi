import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transitionCampaign } from '../account/campaigns/index.ts'
import { signToken } from '../account/tracking/index.ts'
import { sendableInstall, drive, addContacts } from './sending-setup.ts'

// Puts markup into every field a member, admin or reader controls, then reads every page, feed and
// email that shows those fields. Nothing may come back as live markup or a script URL.

const P = `"'><img src=x onerror=alert(1)><script>alert(1)</script></title></style>{{field.evil}}`
const live = [/<img src=x onerror/i, /<script>alert\(1\)/i, /<\/title><\/style>/i, /href="javascript:/i, /src="javascript:/i, /<[^>]*\son(error|click)=/i]

function assertInert(where: string, raw: string) {
  // Escaped text inside a quoted attribute is inert, so blank attribute values before matching.
  const body = raw.replace(/"[^"<>]*"/g, '""')
  for (const pattern of live) assert.ok(!pattern.test(body), `${where} contains live markup ${pattern}: ${body.slice(Math.max(0, body.search(pattern) - 120), body.search(pattern) + 120)}`)
}

test('user-controlled text never becomes live markup in emails, the archive, feeds or hosted pages', async () => {
  const { install, owner, nl, ctx, accountId } = await sendableInstall()
  try {
    await owner.action('newsletters.update', { newsletterId: nl.id, name: `News ${P}`.slice(0, 120), description: `About ${P}`, fromName: 'Weekly', postalAddress: `Street ${P}`, theme: { ...nl.theme, footerText: `Footer ${P}`, header: { logo: 'javascript:alert(1)', title: `Head ${P}` } } } as never)
    await owner.action('contactFields.create', { newsletterId: nl.id, key: 'evil', label: `Label ${P}`, type: 'text' })
    const author = await owner.action('authors.create', { newsletterId: nl.id, name: `Writer ${P}`.slice(0, 120), slug: 'writer', bio: `Bio ${P}`, links: { [`x"><script>`]: 'https://example.com/a' } })
    await owner.action('website.update', { newsletterId: nl.id, settings: { enabled: true, seoTitle: `SEO ${P}`, seoDescription: `Desc ${P}`, socialLinks: { [`s${P}`.slice(0, 50)]: 'https://example.com/s' } } as never })
    await owner.action('signup.update', { newsletterId: nl.id, settings: { buttonLabel: `Go ${P}`.slice(0, 80), successMessage: `Done ${P}`, fieldKeys: ['evil'] }, doubleOptIn: true } as never)
    const [contactId] = addContacts(ctx, nl.id, 1)
    ctx.db.run('UPDATE contacts SET name = ?, fields = ? WHERE id = ?', `Reader ${P}`, JSON.stringify({ evil: P }), contactId)

    const doc = (href: string) => ({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Heading ${P}` }] },
      { type: 'paragraph', content: [{ type: 'text', text: `Hi {{name}} {{field.evil|${P}}} ${P}` }, { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }] },
      { type: 'image', attrs: { src: href, alt: P, caption: P, href } },
      { type: 'button', attrs: { label: P, href } },
      { type: 'callout', attrs: { tone: P, emoji: P }, content: [{ type: 'paragraph', content: [{ type: 'text', text: P }] }] },
      { type: 'embed', attrs: { url: href, title: P, description: P, image: href } },
      { type: 'codeBlock', content: [{ type: 'text', text: P }] },
    ] })
    const issue = await owner.action('campaigns.create', { newsletterId: nl.id, subject: `Subject ${P}`.slice(0, 140), doc: doc(`https://example.com/a?q=${encodeURIComponent(P)}`) as never, audience: { all: true } } as never)
    await owner.action('campaigns.update', { campaignId: issue.id, revision: issue.revision, previewText: `Preview ${P}` })
    await owner.action('campaigns.send', { campaignId: issue.id })
    await drive(install, owner, issue.id)
    const email = install.outbox(accountId).find((row) => row.kind !== 'system' && row.to_email === 'reader0@example.com')
    assert.ok(email, 'the issue was sent')
    assertInert('email html', email.html)
    assert.ok(!/[\r\n]/.test(JSON.parse(email.headers)['List-Unsubscribe'] ?? ''), 'no header injection')
    await owner.action('website.updateIssue', { campaignId: issue.id, slug: 'issue-one', visible: true, authorId: author.id })

    for (const [format, body] of [['doc', { doc: doc('javascript:alert(1)') }], ['markdown', { source: `# T ${P}\n\n[x](javascript:alert(1)) <script>alert(1)</script> ${P}` }], ['html', { html: `<p onclick="alert(1)">${P}</p><a href="javascript:alert(1)">x</a><iframe src="https://example.com"></iframe><style>body{}</style>{{unsubscribe_url}}` }]] as const) {
      const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: `${format} issue`, format, ...body } as never)
      transitionCampaign(ctx, draft.id, 'scheduled', { scheduledAt: ctx.now() + 1000 })
      transitionCampaign(ctx, draft.id, 'sending')
      transitionCampaign(ctx, draft.id, 'sent')
      await owner.action('website.updateIssue', { campaignId: draft.id, slug: `${format}-issue`, visible: true })
    }
    await owner.action('website.publishPost', { newsletterId: nl.id, subject: `Post ${P}`, slug: 'post', source: `Body ${P} <img src=x onerror=alert(1)> [x](javascript:alert(1))`, visible: true })

    const slug = (await owner.action('newsletters.get', { newsletterId: nl.id })).slug
    for (const path of ['', '/issue-one', '/markdown-issue', '/html-issue', '/post', '/authors/writer', '/feed.xml', '/sitemap.xml', '/nothing-here']) {
      const response = await install.fetch(`/n/${slug}${path}`)
      assert.equal(response.status, path === '/nothing-here' ? 404 : 200, `/n/${slug}${path}`)
      assertInert(`/n/${slug}${path}`, await response.text())
    }
    const key = (await owner.action('newsletters.get', { newsletterId: nl.id })).key
    for (const path of [`/f/${key}`, `/embed.js?key=${key}`]) {
      const response = await install.fetch(path)
      assert.equal(response.status, 200, path)
      assertInert(path, await response.text())
    }
    for (const purpose of ['u', 'p'] as const) {
      const token = await signToken(ctx, purpose, [contactId, purpose === 'u' ? issue.id : ''].filter(Boolean))
      const page = await (await install.fetch(`/u/${token}`)).text()
      assert.ok(page.includes('reader0@example.com'), `/u ${purpose} renders`)
      assertInert(`/u ${purpose}`, page)
    }
    const keep = await signToken(ctx, 'k', [contactId, ctx.now()])
    assertInert('/keep', await (await install.fetch(`/keep/${keep}`)).text())
    const preview = await owner.action('campaigns.preview', { campaignId: issue.id })
    assert.ok(preview.email.html.includes('Heading'))
    assertInert('campaign email preview', preview.email.html)
    assertInert('campaign web preview', preview.web.html)
  } finally {
    install.close()
  }
})
