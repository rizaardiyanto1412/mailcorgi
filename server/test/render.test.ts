import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import { Node } from '@tiptap/pm/model'
import { campaignExtensions } from '../../web/src/features/campaigns/extensions.ts'
import { renderEmail, renderWeb, renderDocPreview, markdownToDoc, themePresets, defaultTheme, type DocNode, type DocMark } from '../account/render/index.ts'
import { reviewChecks } from '../account/campaigns/index.ts'

const newsletter = { name: 'Weekly', postal_address: 'Example postal address' }
const links = { unsubscribe: 'https://example.com/u/reader', preferences: 'https://example.com/preferences', web: 'https://example.com/issue' }
const text = (value: string): DocNode => ({ type: 'text', text: value })
const paragraph = (value: string): DocNode => ({ type: 'paragraph', content: [text(value)] })
function render(doc: DocNode) {
  const campaign = { subject: 'Hello {{first_name|friend}}', previewText: 'A small preview', format: 'doc', doc }
  return { email: renderEmail({ campaign, newsletter, theme: {}, recipient: { contact: { name: 'Reader Person' }, links } }), web: renderWeb({ campaign, newsletter, theme: {} }) }
}
const cases: { node: DocNode; html: RegExp; plain: RegExp }[] = [
  { node: paragraph('Paragraph & <copy>'), html: /<p[^>]*>Paragraph &amp; &lt;copy&gt;<\/p>/, plain: /Paragraph & <copy>/ },
  ...[1, 2, 3].map((level) => ({ node: { type: 'heading', attrs: { level }, content: [text('Heading')] } satisfies DocNode, html: new RegExp(`<h${level}[^>]*font-size:`), plain: /Heading/ })),
  { node: { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Bullet')] }] }, html: /<ul[\s\S]*<li[\s\S]*Bullet/, plain: /- Bullet/ },
  { node: { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('Numbered')] }] }, html: /<ol start="3"[\s\S]*<li/, plain: /3\. Numbered/ },
  { node: { type: 'blockquote', content: [paragraph('Quote')] }, html: /<blockquote[^>]*border-left:4px/, plain: /> Quote/ },
  { node: { type: 'codeBlock', content: [text('x < y')] }, html: /<pre[^>]*font-family:Courier[\s\S]*x &lt; y/, plain: /x < y/ },
  { node: { type: 'hardBreak' }, html: /<br>/, plain: /\n/ },
  { node: { type: 'horizontalRule' }, html: /border-top:1px/, plain: /---/ },
  { node: { type: 'divider' }, html: /border-top:1px/, plain: /---/ },
  { node: { type: 'spacer', attrs: { height: 48 } }, html: /height:48px/, plain: /\n/ },
  { node: { type: 'image', attrs: { src: 'https://example.com/photo.png', alt: 'A corgi', width: 400, height: 300, href: 'https://example.com/photo', caption: 'In the garden' } }, html: /alt="A corgi" width="400" height="300"/, plain: /\[A corgi\] \[1\] In the garden/ },
  { node: { type: 'button', attrs: { href: 'https://example.com/button', label: 'Read story', align: 'center' } }, html: /mso-padding-alt:14px 24px[\s\S]*Read story/, plain: /Read story \[1\]/ },
  { node: { type: 'callout', attrs: { emoji: '💡', tone: 'warning' }, content: [paragraph('Notice')] }, html: /border-left:4px solid #854d0e[\s\S]*💡[\s\S]*Notice/, plain: /💡 Notice/ },
  { node: { type: 'embed', attrs: { url: 'https://example.com/card', title: 'Story card', description: 'Worth reading', image: 'https://example.com/thumb.jpg' } }, html: /thumb.jpg[\s\S]*Story card[\s\S]*Worth reading/, plain: /Story card \[1\]\nWorth reading/ },
]
for (const [index, item] of cases.entries()) test(`node ${index}: ${item.node.type} has meaningful email, text and web output`, () => {
  const result = render({ type: 'doc', content: [item.node] })
  assert.match(result.email.html, item.html)
  assert.match(result.web.html, item.html)
  assert.match(result.email.text, item.plain)
})
const markCases: { type: DocMark['type']; pattern: RegExp }[] = [
  { type: 'bold', pattern: /<strong>Marked<\/strong>/ }, { type: 'italic', pattern: /<em>Marked<\/em>/ },
  { type: 'underline', pattern: /<u>Marked<\/u>/ }, { type: 'strike', pattern: /<s>Marked<\/s>/ },
  { type: 'code', pattern: /<code[^>]*font-family:Courier[^>]*>Marked/ }, { type: 'highlight', pattern: /<mark[^>]*background:#fef08a[^>]*>Marked/ },
  { type: 'link', pattern: /href="https:\/\/example.com\/target"[^>]*>Marked/ },
]
for (const mark of markCases) test(`mark ${mark.type} in email, text and web`, () => {
  const result = render({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Marked', marks: [{ type: mark.type, attrs: { href: 'https://example.com/target' } }] }] }] })
  assert.match(result.email.html, mark.pattern)
  assert.match(result.web.html, mark.pattern)
  assert.match(result.email.text, /Marked/)
  if (mark.type === 'link') assert.match(result.email.text, /Marked \[1\][\s\S]*\[1\] https:\/\/example.com\/target/)
})
test('hostile text, attrs, merge values and theme CSS remain inert', () => {
  const attack = '<script>alert(1)</script><img src=x onerror="alert(2)">'
  const doc: DocNode = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: `${attack} {{name}} {{field.company|fallback}}`, marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'highlight', attrs: { color: 'red; background:url(javascript:alert(1))' } }] }] },
    { type: 'heading', attrs: { level: '1; color:red' }, content: [text(attack)] },
    { type: 'image', attrs: { src: 'javascript:alert(1)', alt: attack, width: '10; color:red' } },
    { type: 'image', attrs: { src: 'https://example.com/image', alt: attack, caption: attack, href: 'data:text/html,<script>1</script>' } },
    { type: 'button', attrs: { label: attack, href: '{{field.bad}}', align: 'left" onclick="alert(1)' } },
    { type: 'embed', attrs: { url: 'java\nscript:alert(1)', title: attack, description: attack, image: 'data:image/svg+xml,<svg onload=alert(1)>' } },
    { type: 'callout', attrs: { emoji: attack, tone: 'x; color:red' }, content: [paragraph(attack)] },
  ] }
  const campaign = { subject: '{{name}}\r\nInjected: header', doc }
  const email = renderEmail({ campaign, newsletter, theme: { ...defaultTheme, accent: 'red;position:fixed' }, recipient: { contact: { name: attack, fields: { company: attack, bad: 'javascript:alert(3)' } }, links } })
  const web = renderWeb({ campaign, newsletter, theme: {} })
  for (const html of [email.html, web.html, renderDocPreview(doc, {})]) {
    assert.doesNotMatch(html, /<script|<svg|<img[^>]*\sonerror="|href="(?:javascript|data):|src="(?:javascript|data):|style="[^"]*(?:position:fixed|color:red)/i)
    assert.match(html, /&lt;script&gt;/)
  }
  assert.doesNotMatch(email.subject, /[\r\n]/)
  assert.match(email.html, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/)
})
test('merge fallbacks, system links, tracking hooks, footer and headers', () => {
  const doc: DocNode = { type: 'doc', content: [paragraph('Hi {{first_name|friend}} {{email}} {{field.points|0}}'), { type: 'button', attrs: { label: 'Preferences', href: '{{preferences_url}}' } }, { type: 'paragraph', content: [{ type: 'text', text: 'Article', marks: [{ type: 'link', attrs: { href: 'https://example.com/article' } }] }] }] }
  const wrapped: string[] = []
  const email = renderEmail({ campaign: { subject: '{{name|Reader}}', preview_text: 'Hidden preview', doc }, newsletter, theme: {}, recipient: { contact: { email: 'reader@example.com', fields: '{"points":42}' }, links: { ...links, openPixel: 'https://example.com/open', wrap: (url) => { wrapped.push(url); return `https://example.com/click?url=${encodeURIComponent(url)}` } } } })
  assert.equal(email.subject, 'Reader')
  assert.match(email.text, /Hi friend reader@example.com 42/)
  assert.match(email.html, /display:none[^>]*>Hidden preview/)
  assert.match(email.html, /Example postal address/)
  assert.match(email.html, /https:\/\/example.com\/open" width="1"/)
  assert.ok(wrapped.includes('https://example.com/article'))
  assert.equal(email.headers['List-Unsubscribe'], `<${links.unsubscribe}>`)
  assert.equal(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.doesNotMatch(render({ type: 'doc', content: [paragraph('No pixel')] }).email.html, /width="1" height="1"/)
})
test('Markdown lexer produces safe docs with lists, links, images, code and quotes', () => {
  const doc = markdownToDoc('# Heading\n\n**Bold** and *italic* and ~~strike~~ and `code` [link](https://example.com).\n\n- one\n- two\n\n> quote\n\n```js\nx < y\n```\n\n![photo](https://example.com/a.png)\n\n<script>alert(1)</script>')
  const result = render(doc)
  assert.match(result.email.html, /<h1/)
  assert.match(result.email.html, /<strong>Bold/)
  assert.match(result.web.html, /<em>italic/)
  assert.match(result.email.text, /- one/)
  assert.match(result.email.text, /> quote/)
  assert.match(result.email.html, /&lt;script&gt;/)
  assert.doesNotMatch(result.web.html, /<script/)
})
test('HTML passes through for email, escapes merge values and sanitizes the web archive', () => {
  const campaign = { format: 'html', subject: 'HTML', html: '<p style="color:red">Hello {{name}}</p><a href="https://example.com/link">Article</a><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a>' }
  const email = renderEmail({ campaign, newsletter, theme: {}, recipient: { contact: { name: '<img src=x onerror=alert(1)>' }, links } })
  assert.match(email.html, /<p style="color:red">Hello &lt;img/)
  assert.match(email.text, /Article \[1\]/)
  assert.match(email.text, /\[1\] https:\/\/example.com\/link/)
  const web = renderWeb({ campaign, newsletter, theme: {} })
  assert.doesNotMatch(web.html, /<script|onerror=|javascript:|style="color:red"/)
})
test('review checks identify required fields, bad links, missing alt and Gmail clipping', () => {
  const input = { campaign: { subject: '', doc: { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com/x.png' } }, { type: 'button', attrs: { href: 'javascript:alert(1)' } }] } }, newsletter: {}, theme: {}, domainVerified: false }
  assert.deepEqual(reviewChecks(input).map((c) => c.id), ['subject', 'preview_text', 'postal_address', 'sender_domain', 'image_alt', 'links'])
  const sample = { subject: 'Long issue', previewText: 'Preview', doc: { type: 'doc', content: Array.from({ length: 60 }, () => paragraph('A useful idea. '.repeat(30))) } }
  const rendered = renderEmail({ campaign: sample, newsletter, theme: {}, recipient: { contact: {}, links } })
  assert.ok(new TextEncoder().encode(rendered.html).length < 102 * 1024)
  assert.equal(reviewChecks({ ...input, campaign: sample }).some((c) => c.id === 'email_size'), false)
  assert.equal(reviewChecks({ ...input, campaign: { ...sample, doc: { type: 'doc', content: Array.from({ length: 400 }, () => paragraph('A useful idea. '.repeat(30))) } } }).some((c) => c.id === 'email_size'), true)
  assert.equal(reviewChecks({ ...input, campaign: { subject: 'x'.repeat(151), format: 'html', html: '<a href="{{unsubscribe_url}}">Unsubscribe</a>' } }).some((c) => c.id === 'unsubscribe'), false)
})
test('all presets render safe inline colors and fonts', () => {
  assert.equal(themePresets.length, 5)
  for (const preset of themePresets) {
    const html = renderDocPreview({ type: 'doc', content: [paragraph('Theme')] }, preset.theme)
    assert.ok(html.includes(preset.theme.surface))
    assert.ok(html.includes(preset.theme.text))
  }
})
test('the editor schema round-trips every node and mark without losing JSON', () => {
  const schema = getSchema(campaignExtensions())
  const doc: DocNode = { type: 'doc', content: [...cases.filter((c) => c.node.type !== 'hardBreak').map((c) => c.node), { type: 'paragraph', content: [{ type: 'hardBreak' }, ...markCases.map((m) => ({ type: 'text', text: m.type, marks: [{ type: m.type, attrs: { href: 'https://example.com/link' } }] } satisfies DocNode))] }] }
  const first = Node.fromJSON(schema, doc)
  first.check()
  assert.deepEqual(Node.fromJSON(schema, first.toJSON()).toJSON(), first.toJSON())
  for (const type of new Set(cases.map((c) => c.node.type))) assert.ok(JSON.stringify(first.toJSON()).includes(`"type":"${type}"`))
})
