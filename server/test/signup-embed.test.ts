import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { setTimeout } from 'node:timers/promises'
import { embedScript } from '../account/signup/embed.ts'
import { createInstall } from './harness.ts'

class Element {
  children: Element[] = []
  parentNode: Element | null = null
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>()
  textContent = ''
  name = ''
  type = ''
  value = ''
  src = ''
  checked = false
  disabled = false
  hidden = false
  open = false
  constructor(readonly tag: string) {}
  append(...nodes: Element[]) { for (const node of nodes) { node.parentNode = this; this.children.push(node) } }
  prepend(node: Element) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node: Element, before: Element) { node.parentNode = this; this.children.splice(this.children.indexOf(before), 0, node) }
  after(node: Element) { node.parentNode = this.parentNode; this.parentNode?.children.splice(this.parentNode.children.indexOf(this) + 1, 0, node) }
  before(node: Element) { node.parentNode = this.parentNode; this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 0, node) }
  replaceWith(node: Element) { if (this.parentNode) { node.parentNode = this.parentNode; this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1, node) } }
  setAttribute(key: string, value: string) { this.attributes[key] = value }
  addEventListener(event: string, handler: (event: { preventDefault(): void }) => unknown) { this.listeners.set(event, handler) }
  showModal() { this.open = true }
  close() { this.open = false }
  find(predicate: (node: Element) => boolean): Element | undefined { return predicate(this) ? this : this.children.map((n) => n.find(predicate)).find(Boolean) }
}

for (const mode of ['inline', 'popup']) test(`embed ${mode} runs against the public API, recovers from errors and displays success`, async () => {
  const install = await createInstall()
  try {
    assert.ok(new TextEncoder().encode(embedScript).length < 8 * 1024)
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly <script>bad()</script>' })
    const base = (await owner.action('signup.get', { newsletterId: nl.id })).settings
    await owner.action('signup.update', { newsletterId: nl.id, settings: base, doubleOptIn: false })
    const body = new Element('body'), script = new Element('script'), head = new Element('head')
    script.src = `http://app.example.com/embed.js?key=${nl.key}`
    script.dataset.mode = mode
    body.append(script)
    let fail = true
    const requests: Request[] = []
    runInNewContext(embedScript, {
      document: { currentScript: script, head, createElement: (tag: string) => new Element(tag) },
      URL, window: { location: { assign: () => assert.fail('Unexpected redirect') } },
      fetch: async (input: string, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push(request)
        if (init?.method === 'POST' && fail) { fail = false; return Response.json({ error: 'Try again.' }, { status: 503 }) }
        const result = await install.fetch(input, init)
        if (!init?.method) install.clock.advance(2001)
        return result
      },
    })
    for (let i = 0; i < 100 && !body.find((n) => n.tag === 'form'); i++) await setTimeout(5)
    const form = body.find((n) => n.tag === 'form')
    assert.ok(form)
    assert.equal(form.style.backgroundColor, '#ffffff')
    assert.equal(body.find((n) => n.tag === 'h2')?.textContent, nl.name)
    const email = form.find((n) => n.name === 'email')!
    email.value = 'reader@example.com'
    form.find((n) => n.name === 'name')!.value = 'Reader'
    const submit = form.listeners.get('submit')!
    await submit({ preventDefault() {} })
    assert.equal(body.find((n) => n.attributes.role === 'status')?.textContent, 'Try again.')
    assert.equal(form.find((n) => n.tag === 'button')?.disabled, false)
    await submit({ preventDefault() {} })
    assert.equal(form.hidden, true)
    assert.equal(body.find((n) => n.attributes.role === 'status')?.textContent, base.successMessage)
    assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0].status, 'subscribed')
    assert.equal(requests[0].url, `http://app.example.com/api/public/subscribe/${nl.key}`)
    if (mode === 'popup') {
      const dialog = body.find((n) => n.tag === 'dialog')!
      assert.ok(dialog)
      await body.children.find((n) => n.tag === 'button')!.listeners.get('click')!({ preventDefault() {} })
      assert.equal(dialog.open, true)
      await dialog.children[0].listeners.get('click')!({ preventDefault() {} })
      assert.equal(dialog.open, false)
    }
    assert.equal((await install.fetch(`/embed.js?key=${nl.key}`)).headers.get('content-type'), 'application/javascript; charset=utf-8')
  } finally { install.close() }
})
