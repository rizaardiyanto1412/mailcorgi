/**
 * Rows written per operation, measured on `wrangler dev` (or the Node build with --node) through the
 * dev-only `/api/dev/writes` meter. Prints a table for docs/performance.md. Flags: --node runs the
 * Node build instead of wrangler, --idle <seconds> shortens the two idle waits (default 60).
 *
 * Usage: npm run build && npm run budget
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createSmokeContext, SMOKE_DNS, sleep, waitUntil } from './smoke-context.ts'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const useNode = args.includes('--node')
const idleSeconds = Number(args[args.indexOf('--idle') + 1]) || 60
const verbose = !!process.env.BUDGET_VERBOSE

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

function start(cmd: string, cmdArgs: string[], env: Record<string, string>, label: string): ChildProcess {
  const child = spawn(cmd, cmdArgs, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const log = (chunk: Buffer) => {
    if (verbose) for (const line of chunk.toString().split('\n')) if (line.trim()) console.log(`[${label}] ${line}`)
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

async function waitFor(url: string, child: ChildProcess, ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`budget: the server exited with ${child.exitCode} before it was ready`)
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(300)
  }
  throw new Error(`budget: ${url} did not come up within ${ms} ms`)
}

interface Meter { writes: number; reads: number; stores: Record<string, { writes: number; reads: number }> }

async function scenario(base: string) {
  const { jar, json, action, call, expect } = createSmokeContext(base)
  const rows: [string, number, number][] = []
  let accountId = ''
  // Each object's meter is in memory and starts over when the runtime evicts an idle object, so a
  // running total is kept here: a count that went down means a fresh instance.
  const last = new Map<string, { writes: number; reads: number }>()
  const total = { writes: 0, reads: 0 }
  const meter = async () => {
    const r = await fetch(`${base}/api/dev/writes?accounts=${accountId}`)
    if (!r.ok) throw new Error(`budget: /api/dev/writes answered ${r.status}; is MC_TEST_DNS on?`)
    const { stores } = (await r.json()) as Meter
    for (const [id, now] of Object.entries(stores)) {
      const prev = last.get(id) ?? { writes: 0, reads: 0 }
      total.writes += now.writes >= prev.writes ? now.writes - prev.writes : now.writes
      total.reads += now.reads >= prev.reads ? now.reads - prev.reads : now.reads
      last.set(id, now)
    }
    return { ...total }
  }
  const measure = async (label: string, fn: () => Promise<unknown>) => {
    const before = await meter()
    await fn()
    const after = await meter()
    rows.push([label, after.writes - before.writes, after.reads - before.reads])
    if (verbose) console.log(`${label}: ${after.writes - before.writes} writes, ${after.reads - before.reads} reads`)
  }
  // Reading the meter every few seconds keeps the objects' counts from being lost mid-wait.
  const idle = async (seconds: number) => {
    for (let waited = 0; waited < seconds; waited += 5) {
      await sleep(Math.min(5, seconds - waited) * 1000)
      await meter()
    }
  }

  // Setup is not measured: a fresh install writes its migrations, the first user and the account.
  await json('POST', '/api/auth/setup', { name: 'Budget Tester', email: 'budget@example.com', password: 'budget test password' })
  const session = (await json('GET', '/api/auth/bootstrap')).session
  jar.csrf = session.csrf
  accountId = session.current
  const nl = await action('newsletters.create', { name: 'Budget Weekly' })
  const domain = await action('domains.add', { name: 'smoke.example.com' })
  await action('domains.check', { domainId: domain.id })
  await action('newsletters.update', { newsletterId: nl.id, fromName: 'Budget', fromLocal: 'news', domainId: domain.id, postalAddress: '1 Example Street' })
  await action('signup.update', { newsletterId: nl.id, settings: (await action('signup.get', { newsletterId: nl.id })).settings, doubleOptIn: false })
  const website = await action('website.get', { newsletterId: nl.id })
  await action('website.update', { newsletterId: nl.id, settings: { ...website.settings, enabled: true } })
  // Let the alarm settle the jobs setup queued.
  await sleep(3000)

  await measure('SPA index (GET /)', async () => expect((await call('GET', '/')).status === 200, 'index served'))
  await measure('SPA index, second request', async () => expect((await call('GET', '/')).status === 200, 'index served'))
  await measure('GET /healthz', async () => expect((await call('GET', '/healthz')).status === 200, 'healthz'))
  await measure('GET /api/auth/bootstrap', () => json('GET', '/api/auth/bootstrap'))
  await measure('contacts.list', () => action('contacts.list', { newsletterId: nl.id, limit: 50 }))
  await measure('stats.overview', () => action('stats.overview', { newsletterId: nl.id, range: '30' }))
  await measure('website page view (GET /n/<slug>/)', async () => {
    const r = await fetch(`${base}/n/${nl.slug}/`, { headers: { 'user-agent': 'Mozilla/5.0 (budget reader)' } })
    expect(r.status === 200, `website page answered ${r.status}`)
  })
  await measure('website page view, second visitor', async () => {
    const r = await fetch(`${base}/n/${nl.slug}/`, { headers: { 'user-agent': 'Mozilla/5.0 (budget reader two)', referer: 'https://example.org/' } })
    expect(r.status === 200, `website page answered ${r.status}`)
  })
  const config = await json('GET', `/api/public/subscribe/${nl.key}`)
  await sleep(2100)
  await measure('public subscribe (POST)', async () => {
    const r = await fetch(`${base}/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ email: 'reader-signup@example.com', formToken: config.formToken }) })
    expect(r.status === 200, `subscribe answered ${r.status}`)
  })
  await measure('import one contact (upload, start, process)', async () => {
    const created = await action('imports.create', { newsletterId: nl.id, mapping: { email: 'Email', name: 'Name', status: 'Status' }, options: { consent: true } })
    await action('imports.addChunk', { newsletterId: nl.id, importId: created.id, seq: 0, rows: [{ Email: 'reader-import@example.com', Name: 'Imported Reader', Status: 'subscribed' }] })
    await action('imports.start', { newsletterId: nl.id, importId: created.id, totalRows: 1 })
    await waitUntil('import of one contact', 60_000, async () => {
      const r = await action('imports.get', { newsletterId: nl.id, importId: created.id })
      if (['failed', 'canceled', 'stalled'].includes(r.status)) throw new Error(`budget: import ended as ${r.status}: ${r.error}`)
      return r.status === 'completed' ? r : null
    }, 500)
  })
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello reader.' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'A link', marks: [{ type: 'link', attrs: { href: 'https://example.com/budget' } }] }] }] }
  const draft = await action('campaigns.create', { newsletterId: nl.id, subject: 'Budget issue', doc })
  await action('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'A preview' })
  let sentRows = 0
  await measure('send one issue to two readers (plan, send, finish)', async () => {
    await action('campaigns.send', { campaignId: draft.id })
    const done = await waitUntil('the issue to be sent', 90_000, async () => {
      const c = await action('campaigns.get', { campaignId: draft.id })
      return c.status === 'sent' ? c : null
    }, 500)
    sentRows = done.stats?.sent ?? 2
  })
  const outbox = await action('dev.outbox', { limit: 10 })
  const email = outbox.emails.find((e: { subject: string }) => e.subject === 'Budget issue')
  expect(!!email, 'the sent issue is in the outbox')
  const html = email.html as string
  const openToken = /\/t\/o\/([A-Za-z0-9_.-]+)/.exec(html)?.[1]
  const clickToken = /\/t\/c\/([A-Za-z0-9_.-]+)/.exec(html)?.[1]
  expect(!!openToken && !!clickToken, 'the email carries tracking tokens')
  await sleep(3100)
  const reader = { headers: { 'user-agent': 'Mozilla/5.0 (budget reader)' }, redirect: 'manual' as const }
  await measure('first open (GET /t/o/)', async () => expect((await fetch(`${base}/t/o/${openToken}`, reader)).status === 200, 'pixel'))
  await measure('repeat open of the same delivery', async () => expect((await fetch(`${base}/t/o/${openToken}`, reader)).status === 200, 'pixel'))
  await measure('first click (GET /t/c/)', async () => expect((await fetch(`${base}/t/c/${clickToken}`, reader)).status === 302, 'redirect'))
  await measure(`idle ${idleSeconds} s, nothing queued but the flush of the views and opens above`, () => idle(idleSeconds))
  const later = await action('campaigns.create', { newsletterId: nl.id, subject: 'Budget later', doc })
  await action('campaigns.update', { campaignId: later.id, revision: later.revision, previewText: 'A preview' })
  await action('campaigns.schedule', { campaignId: later.id, scheduledAt: Date.now() + 86_400_000 })
  await measure(`idle ${idleSeconds} s with a campaign scheduled for tomorrow`, () => idle(idleSeconds))

  const width = Math.max(...rows.map(([label]) => label.length))
  console.log(`\nRows written per operation (${useNode ? 'Node build, changes()' : 'wrangler dev, rowsWritten incl. index entries'}; the sent issue went to ${sentRows} readers):\n`)
  console.log(`| ${'Operation'.padEnd(width)} | Rows written | Rows read |`)
  console.log(`|${'-'.repeat(width + 2)}|---|---|`)
  for (const [label, writes, reads] of rows) console.log(`| ${label.padEnd(width)} | ${writes} | ${reads} |`)
}

const devEnv = { MC_TEST_DNS: JSON.stringify(SMOKE_DNS) }

async function runNode() {
  if (!fs.existsSync(path.join(root, 'dist/index.js')) || !fs.existsSync(path.join(root, 'web/dist/index.html'))) throw new Error('budget: run "npm run build" first')
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-budget-node-'))
  const base = `http://127.0.0.1:${port}`
  const child = start('node', ['--disable-warning=ExperimentalWarning', 'dist/index.js'], { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_URL: base, SEND_RATE_PER_SECOND: '100', ...devEnv }, 'node')
  try {
    await waitFor(`${base}/healthz`, child, 20_000)
    await scenario(base)
  } finally {
    stop(child)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

async function runWrangler() {
  if (!fs.existsSync(path.join(root, 'web/dist/index.html'))) throw new Error('budget: run "npm run build" first')
  const port = await freePort()
  const inspector = await freePort()
  const persist = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-budget-cf-'))
  const base = `http://127.0.0.1:${port}`
  const vars = Object.entries({ APP_URL: base, SEND_RATE_PER_SECOND: '100', ...devEnv }).flatMap(([key, value]) => ['--var', `${key}:${value}`])
  const child = start(
    'npx',
    ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', persist, ...vars, '--show-interactive-dev-session=false', '--log-level', 'warn'],
    { CI: '1', WRANGLER_SEND_METRICS: 'false' },
    'wrangler',
  )
  try {
    await waitFor(`${base}/healthz`, child, 90_000)
    await scenario(base)
  } finally {
    stop(child)
    fs.rmSync(persist, { recursive: true, force: true })
  }
}

fs.mkdirSync(path.join(root, '.audit'), { recursive: true })
try {
  await (useNode ? runNode() : runWrangler())
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
}
