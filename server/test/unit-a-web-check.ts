import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import { serve } from '@hono/node-server'
import { createServer } from 'vite'
import { createInstall } from './harness.ts'
import type { ActionInput, ActionName, ActionOutput } from '../registry.ts'

const auditRoot = path.resolve('.audit')
fs.mkdirSync(auditRoot, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(auditRoot, 'unit-a-web-'))
const install = await createInstall({ dataDir })
const backend = serve({ fetch: (request) => install.app.edge.fetch(request), port: 0, hostname: '127.0.0.1' })
await new Promise<void>((resolve) => backend.once('listening', resolve))
const backendAddress = backend.address()
assert.ok(backendAddress && typeof backendAddress === 'object')
const vite = await createServer({ server: { port: 0, host: '127.0.0.1', allowedHosts: ['app.example.com'], proxy: { '/api': { target: `http://127.0.0.1:${backendAddress.port}`, changeOrigin: false }, '/img': { target: `http://127.0.0.1:${backendAddress.port}`, changeOrigin: false } } } })
try {
  await vite.listen()
  const address = vite.httpServer?.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const owner = await install.signUp({ email: 'owner@example.com' })
  const action = async <K extends ActionName>(name: K, input: ActionInput<K>): Promise<ActionOutput<K>> => {
    const { stdout: body } = await exec('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', '-X', 'POST', '-H', 'Host: app.example.com', '-H', 'Cookie: ' + owner.cookie, '-H', 'x-mc-csrf: ' + owner.csrf, '-H', 'content-type: application/json', '--data-binary', JSON.stringify(input), `${base}/api/actions/${name}`], { encoding: 'utf8' })
    return JSON.parse(body)
  }
  const newsletter = await action('newsletters.create', { name: 'Web check' })
  const newsletterId = newsletter.id
  const tag = await action('tags.create', { newsletterId, name: 'Readers' })
  const field = await action('contactFields.create', { newsletterId, key: 'city', label: 'City', type: 'text' })
  const created = await action('contacts.create', { newsletterId, email: 'reader@example.com', name: 'Reader', fields: { city: 'Example City' }, tags: [tag.id] })
  assert.equal(created.outcome, 'subscribed')
  const contactId = created.contact.id
  const pages = ['/contacts', '/contacts/' + contactId, '/segments', '/settings/contacts', '/settings/suppressions', '/settings/newsletter', '/settings/authors', '/settings/design']
  for (const page of pages) {
    const { stdout: html } = await exec('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', '-H', 'Host: app.example.com', '-H', 'Cookie: ' + owner.cookie, base + page], { encoding: 'utf8' })
    assert.match(html, /id="root"/)
    console.log(`SPA ${page}: 200`)
  }
  assert.equal((await action('contacts.list', { newsletterId, tagId: tag.id })).contacts.length, 1)
  assert.equal((await action('contacts.get', { newsletterId, contactId })).tags[0].id, tag.id)
  assert.equal((await action('contactFields.list', { newsletterId })).fields[0].id, field.id)
  assert.equal((await action('tags.list', { newsletterId })).tags[0].id, tag.id)
  const segment = await action('segments.create', { newsletterId, name: 'Readers in Example City', filter: { field: 'custom', key: 'city', op: 'eq', value: 'Example City' } })
  assert.equal((await action('segments.count', { newsletterId, filter: segment.filter })).count, 1)
  assert.equal((await action('segments.list', { newsletterId })).segments.length, 1)
  const author = await action('authors.create', { newsletterId, name: 'Editor', slug: 'editor' })
  assert.equal((await action('authors.list', { newsletterId })).authors[0].id, author.id)
  const settings = await action('newsletters.update', { newsletterId, fromName: 'Editor', fromLocal: 'newsletter', replyTo: 'reply@example.com', postalAddress: '123 Example Street', language: 'en', timezone: 'UTC', tracking: { opens: true, clicks: false } })
  assert.equal(settings.tracking.clicks, false)
  const design = await action('newsletters.update', { newsletterId, theme: { accent: '#112233', font: 'serif' } })
  assert.equal(design.theme.accent, '#112233')
  await action('suppressions.add', { accountId: owner.accountId!, email: 'reader@example.com' })
  const suppressions = await action('suppressions.list', { accountId: owner.accountId! })
  assert.ok(suppressions.suppressions.some((s) => s.reason === 'manual'))
  const { stdout: csv } = await exec('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', '-H', 'Host: app.example.com', '-H', 'Cookie: ' + owner.cookie, base + '/api/actions/contacts.export?newsletterId=' + newsletterId], { encoding: 'utf8' })
  assert.match(csv, /reader@example.com/)
  await action('newsletters.archive', { newsletterId })
  assert.equal((await action('newsletters.list', {})).newsletters.length, 0)
  assert.equal((await action('newsletters.list', { includeArchived: true })).newsletters.length, 1)
  await action('newsletters.unarchive', { newsletterId })
  console.log('unit A: page actions, CSV stream and restore passed through the Vite proxy')
  console.log('unit A: dev servers used random ports and will now stop')
} finally {
  await vite.close()
  if ('closeAllConnections' in backend) backend.closeAllConnections()
  await new Promise<void>((resolve, reject) => backend.close((err) => err ? reject(err) : resolve()))
  install.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
