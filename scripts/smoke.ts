/**
 * Drives a running instance over HTTP: first-run setup, sign in, create a newsletter, read it
 * back, /healthz. With --url it targets that instance; without, it starts the Node build and a
 * `wrangler dev` Worker in turn on random free ports and runs against each.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const argUrl = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : null

class Jar {
  cookies: Record<string, string> = {}
  csrf = ''
  absorb(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (attrs.some((a) => /max-age=0/i.test(a)) || !value) delete this.cookies[name]
      else this.cookies[name] = value
    }
  }
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }
}

async function call(base: string, jar: Jar, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: jar.header() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (jar.csrf && method !== 'GET') headers['x-mc-csrf'] = jar.csrf
  const response = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
  jar.absorb(response)
  return response
}

const expect = (ok: unknown, message: string) => {
  if (!ok) throw new Error(`smoke: ${message}`)
}

async function scenario(base: string) {
  const jar = new Jar()
  const json = async (method: string, p: string, body?: unknown, status = 200) => {
    const r = await call(base, jar, method, p, body)
    const data = await r.json().catch(() => null)
    expect(r.status === status, `${method} ${p} answered ${r.status}: ${JSON.stringify(data)}`)
    return data
  }
  const health = await json('GET', '/healthz')
  expect(health.ok === true, '/healthz ok')
  const index = await call(base, jar, 'GET', '/')
  expect(index.status === 200 && (await index.text()).includes('id="root"'), 'the SPA index is served')
  const boot = await json('GET', '/api/auth/bootstrap')
  expect(boot.setupRequired === true, 'a fresh install needs setup')
  await json('POST', '/api/auth/setup', { name: 'Smoke Tester', email: 'smoke@example.com', password: 'smoke test password' })
  const session = (await json('GET', '/api/auth/bootstrap')).session
  expect(session?.user?.email === 'smoke@example.com' && session.current, 'setup created a session and an account')
  jar.csrf = session.csrf
  expect((await json('POST', '/api/actions/newsletters.list', {})).newsletters.length === 0, 'no newsletters yet, so the app lands on /welcome')
  const created = await json('POST', '/api/actions/newsletters.create', { name: 'Smoke Weekly' })
  expect(created.slug === 'smoke-weekly', 'the newsletter got its slug')
  const read = await json('POST', '/api/actions/newsletters.get', { newsletterId: created.id })
  expect(read.name === 'Smoke Weekly', 'the newsletter reads back')
  const list = await json('POST', '/api/actions/newsletters.list', {})
  expect(list.newsletters.length === 1, 'the list has one newsletter')
  const key = await json('POST', '/api/actions/apikeys.create', { name: 'Smoke API', access: 'full' })
  const apiHeaders = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const api = await fetch(`${base}/api/v1/newsletters`, { headers: apiHeaders })
  expect(api.ok && (await api.json()).newsletters[0].id === created.id, 'API key reads newsletters')
  const mcp = async (id: number, method: string, params: unknown = {}) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: apiHeaders, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    expect(response.ok, `MCP ${method} answered ${response.status}`)
    return response.json()
  }
  const initialized = await mcp(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'MailCorgi smoke', version: '1' } })
  expect(initialized.result?.protocolVersion === '2025-06-18', 'MCP initializes')
  const tools = await mcp(2, 'tools/list')
  expect(tools.result?.tools.some((tool: { name: string }) => tool.name === 'newsletters_list'), 'MCP lists registry tools')
  const tool = await mcp(3, 'tools/call', { name: 'newsletters_list', arguments: {} })
  expect(tool.result?.isError === false && tool.result.structuredContent.newsletters[0].id === created.id, 'MCP calls a tool')
  const docs = await json('POST', '/api/actions/api.reference', {})
  expect(docs.endpoints.some((endpoint: { name: string }) => endpoint.name === 'newsletters.list'), 'API reference reads the registry')
  const keys = await json('POST', '/api/actions/apikeys.list', {})
  expect(keys.keys.some((item: { id: string }) => item.id === key.id), 'API settings lists the created key')
  for (const page of ['/settings/api', '/docs/api']) {
    const response = await call(base, jar, 'GET', page)
    expect(response.ok && (await response.text()).includes('id="root"'), `${page} serves the SPA`)
  }
  const llms = await fetch(`${base}/llms.txt`)
  expect(llms.ok && (await llms.text()).includes('newsletters_list'), 'llms.txt serves the generated reference')
  await json('POST', '/api/actions/apikeys.revoke', { keyId: key.id })
  expect((await fetch(`${base}/api/v1/newsletters`, { headers: apiHeaders })).status === 401, 'revoked API keys are refused')
  const deepLink = await call(base, jar, 'GET', '/campaigns')
  expect(deepLink.status === 200, 'client-side routes fall back to the SPA')
  await json('POST', '/api/auth/signout', {})
  expect((await json('GET', '/api/auth/bootstrap')).session === null, 'signed out')
  await json('POST', '/api/auth/signin', { email: 'smoke@example.com', password: 'smoke test password' })
  const again = (await json('GET', '/api/auth/bootstrap')).session
  expect(again?.user?.email === 'smoke@example.com', 'signed in again')
  const forged = await call(base, jar, 'POST', '/api/actions/newsletters.list', {})
  expect(forged.status === 403, 'a request without the CSRF header is refused')
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

async function waitFor(url: string, child: ChildProcess, ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`smoke: the server exited with ${child.exitCode} before it was ready`)
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`smoke: ${url} did not come up within ${ms} ms`)
}

function start(cmd: string, args: string[], env: Record<string, string>, label: string): ChildProcess {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const log = (chunk: Buffer) => {
    if (process.env.SMOKE_VERBOSE) for (const line of chunk.toString().split('\n')) if (line.trim()) console.log(`[${label}] ${line}`)
  }
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)
  return child
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 3000).unref()
}

async function runNode() {
  if (!fs.existsSync(path.join(root, 'dist/index.js')) || !fs.existsSync(path.join(root, 'web/dist/index.html'))) throw new Error('smoke: run "npm run build" first')
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-smoke-node-'))
  const base = `http://127.0.0.1:${port}`
  const child = start('node', ['--disable-warning=ExperimentalWarning', 'dist/index.js'], { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_URL: base }, 'node')
  try {
    await waitFor(`${base}/healthz`, child, 20_000)
    await scenario(base)
    console.log(`smoke: node ok (${base})`)
  } finally {
    stop(child)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

async function runDev() {
  const port = await freePort()
  const webPort = await freePort()
  const dataDir = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-smoke-dev-'))
  const base = `http://127.0.0.1:${webPort}`
  const api = start('npx', ['tsx', 'server/index.ts'], { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_URL: base }, 'dev-api')
  const web = start('npx', ['vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { PORT: String(port), WEB_PORT: String(webPort) }, 'dev-web')
  try {
    await waitFor(`${base}/healthz`, web, 20_000)
    await scenario(base)
    console.log(`smoke: Vite dev pages and actions ok (${base})`)
  } finally {
    stop(web)
    stop(api)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

async function runWrangler() {
  const port = await freePort()
  const inspector = await freePort()
  const persist = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-smoke-cf-'))
  const base = `http://127.0.0.1:${port}`
  const child = start(
    'npx',
    ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', persist, '--var', `APP_URL:${base}`, '--show-interactive-dev-session=false', '--log-level', 'warn'],
    { CI: '1', WRANGLER_SEND_METRICS: 'false' },
    'wrangler',
  )
  try {
    await waitFor(`${base}/healthz`, child, 90_000)
    await scenario(base)
    console.log(`smoke: wrangler dev ok (${base})`)
  } finally {
    stop(child)
    fs.rmSync(persist, { recursive: true, force: true })
  }
}

fs.mkdirSync(path.join(root, '.audit'), { recursive: true })

try {
  if (argUrl) {
    await scenario(argUrl)
    console.log(`smoke: ok (${argUrl})`)
  } else if (process.argv.includes('--dev')) {
    await runDev()
  } else {
    await runNode()
    await runWrangler()
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
}
