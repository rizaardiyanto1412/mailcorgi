import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import { createServer } from 'vite'
import { createInstall } from './harness.ts'

const install = await createInstall()
const api = serve({ fetch: (request) => install.app.edge.fetch(request), hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) => api.once('listening', resolve))
const address = api.address()
assert.ok(address && typeof address !== 'string')
process.env.PORT = String(address.port)
const web = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false })
try {
  await web.listen()
  const webAddress = web.httpServer?.address()
  assert.ok(webAddress && typeof webAddress !== 'string')
  const base = `http://127.0.0.1:${webAddress.port}`
  install.config.appUrl = base
  for (const page of ['/settings/domains', '/admin/email']) {
    const { stdout: html } = await promisify(execFile)('curl', ['--fail', '--silent', '--max-time', '10', `${base}${page}`], { encoding: 'utf8', timeout: 15_000 })
    assert.match(html, /id="root"/)
    console.log(`ui check: ${page} SPA served`)
  }
  let cookie = ''
  let csrf = ''
  async function call(p: string, body?: unknown) {
    const response = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', 'x-mc-csrf': csrf }, body: body === undefined ? undefined : JSON.stringify(body) })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) cookie = cookies.map((line) => line.split(';')[0]).join('; ')
    const data = await response.json()
    assert.equal(response.status, 200, `${p}: ${JSON.stringify(data)}`)
    return data
  }
  await call('/api/auth/setup', { name: 'UI tester', email: 'tester@example.com', password: 'test password for dev check' })
  csrf = (await call('/api/auth/bootstrap')).session.csrf
  const action = (name: string, input: unknown = {}) => call(`/api/actions/${name}`, input)
  assert.deepEqual(await action('domains.list'), [])
  await action('install.settings.get')
  await action('install.settings.set', { values: { email_provider: 'test', email_from: 'system@example.com', sending_enabled: 'true' } })
  await action('install.email.test', { to: 'tester@example.com' })
  const domain = await action('domains.add', { name: 'example.com' })
  assert.equal((await action('domains.check', { domainId: domain.id })).status, 'pending')
  install.dns.set('example.com', 'TXT', ['v=spf1 include:example.com ~all'])
  install.dns.set('_dmarc.example.com', 'TXT', ['v=DMARC1; p=none'])
  assert.equal((await action('domains.check', { domainId: domain.id })).status, 'verified')
  const newsletter = await action('newsletters.create', { name: 'UI Weekly' })
  assert.equal((await action('domains.senders', { newsletterId: newsletter.id }))[0].id, domain.id)
  await action('domains.delete', { domainId: domain.id })
  assert.deepEqual(await action('domains.list'), [])
  console.log('ui check: settings save/read/test and domain list/add/check/senders/delete actions passed')
} finally {
  await web.close()
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()))
  install.close()
}
