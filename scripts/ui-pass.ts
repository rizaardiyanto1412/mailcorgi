/**
 * Browser pass over the whole app. Starts the Node build on a random port with a temp data dir,
 * seeds a demo install through the public API, then loads every page in Chromium at desktop and
 * phone width, light and dark. Any console error, uncaught exception, failed request or 4xx/5xx
 * from the app fails the run. Screenshots go to docs/screenshots/<theme>/<viewport>/<page>.png.
 *
 *   npm run build && npm run ui:pass
 *   UI_PASS_ONLY=campaign npm run ui:pass     only pages whose name matches
 *   UI_PASS_KEEP=1 npm run ui:pass            keep the data dir and print its path
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { Jar, call } from './smoke-context.ts'

const root = path.resolve(import.meta.dirname, '..')
const shots = path.join(root, 'docs/screenshots')
const only = process.env.UI_PASS_ONLY ? new RegExp(process.env.UI_PASS_ONLY, 'i') : null
const PASSWORD = 'demo password 123'
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const
const THEMES = ['light', 'dark'] as const
type Viewport = keyof typeof VIEWPORTS
type Theme = (typeof THEMES)[number]

// Node's fetch can reuse a keep-alive socket the server just closed. Retry that one case.
const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  try {
    return await nativeFetch(input, init)
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code
    if (code !== 'ECONNRESET' && code !== 'UND_ERR_SOCKET') throw err
    return nativeFetch(input, init)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

// ---------------------------------------------------------------------------------------------
// Server and HTTP client
// ---------------------------------------------------------------------------------------------

/** Canned DNS (`MC_TEST_DNS`), so the run never reaches a real resolver. */
const UI_PASS_DNS = { 'MX:example.com': ['mx.example.com'] }

function startServer(port: number, dataDir: string, base: string, extra: Record<string, string> = {}): ChildProcess {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_URL: base, EMAIL_PROVIDER: 'test', SEND_RATE_PER_SECOND: '500', SEND_BATCH_SIZE: '200', ALLOWED_EMAILS: '', MC_TEST_DNS: JSON.stringify(UI_PASS_DNS), ...extra }
  // A private copy of the build: parallel checkouts that clean up their own servers by command
  // line (`pkill -f dist/index.js`) must not stop this one.
  const entry = path.join(dataDir, '..', `ui-pass-server-${port}.mjs`)
  fs.copyFileSync(path.join(root, 'dist/index.js'), entry)
  const child = spawn('node', ['--disable-warning=ExperimentalWarning', entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.on('exit', () => fs.rmSync(entry, { force: true }))
  const log = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      fs.appendFileSync(serverLog, line + '\n')
      if (process.env.UI_PASS_VERBOSE || /\[(uncaught|unhandled)\]|Error|Shutting down/.test(line)) console.log(`[server] ${line}`)
      if (/\[(uncaught|unhandled)\]/.test(line)) serverErrors.push(line)
    }
  }
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)
  child.on('exit', (code, signal) => {
    if (!stopping.has(child)) serverErrors.push(`the server exited early (code ${code}, signal ${signal})`)
  })
  return child
}
const stopping = new Set<ChildProcess>()
const serverErrors: string[] = []
const serverLog = path.join(root, '.audit', 'ui-pass-server.log')

function stopServer(child: ChildProcess) {
  stopping.add(child)
  if (child.exitCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

class Client {
  jar = new Jar()
  constructor(readonly base: string) {}
  async raw(method: string, p: string, body?: unknown) {
    return call(this.base, this.jar, method, p, body)
  }
  async json<T = any>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await this.raw(method, p, body)
    const data = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`${method} ${p} answered ${r.status}: ${JSON.stringify(data)}`)
    return data as T
  }
  action<T = any>(name: string, input: unknown = {}): Promise<T> {
    return this.json<T>('POST', `/api/actions/${name}`, input)
  }
  async refreshCsrf() {
    const boot = await this.json('GET', '/api/auth/bootstrap')
    this.jar.csrf = boot.session?.csrf ?? ''
    return boot
  }
  async signIn(email: string) {
    await this.json('POST', '/api/auth/signin', { email, password: PASSWORD })
    return this.refreshCsrf()
  }
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(250)
  }
  throw new Error(`ui-pass: timed out waiting for ${label}`)
}

// ---------------------------------------------------------------------------------------------
// Direct seeds: only what the test provider and an offline install cannot produce through the API.
// ---------------------------------------------------------------------------------------------

function withDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** DNS lookups would reach the network, so the sending domain is marked verified directly. */
function verifyDomain(accountDb: string, domainId: string) {
  withDb(accountDb, (db) => {
    const row = db.prepare('SELECT records FROM domains WHERE id = ?').get(domainId) as { records: string }
    const records = (JSON.parse(row.records) as Record<string, unknown>[]).map((r) => ({ ...r, found: true }))
    db.prepare("UPDATE domains SET status = 'verified', records = ?, verified_at = ?, last_checked_at = ? WHERE id = ?").run(JSON.stringify(records), Date.now(), Date.now(), domainId)
  })
}

/** The test provider reports no delivery events, so a few deliveries are marked bounced directly. */
function bounceSome(accountDb: string, campaignId: string, n: number) {
  withDb(accountDb, (db) => {
    const ids = db.prepare("SELECT id FROM deliveries WHERE campaign_id = ? AND status IN ('sent', 'delivered') AND opened_at IS NULL ORDER BY id DESC LIMIT ?").all(campaignId, n) as { id: number }[]
    for (const { id } of ids) db.prepare("UPDATE deliveries SET status = 'bounced', bounced_at = ? WHERE id = ?").run(Date.now(), id)
    db.prepare("UPDATE deliveries SET status = 'delivered', delivered_at = COALESCE(delivered_at, sent_at) WHERE campaign_id = ? AND status = 'sent'").run(campaignId)
  })
}

const outbox = (file: string, where = '1 = 1', ...params: string[]) =>
  withDb(file, (db) => db.prepare(`SELECT to_email, subject, html, text, kind FROM outbox WHERE ${where} ORDER BY rowid`).all(...params) as { to_email: string; subject: string; html: string; text: string; kind: string }[])

/** A solid 600x300 PNG with a darker band, built by hand so the script needs no image library. */
function demoPng(): string {
  const w = 600
  const h = 300
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    for (let x = 0; x < w; x++) {
      const band = y > 180 && y < 220
      raw[row + 1 + x * 3] = band ? 154 : 253
      raw[row + 2 + x * 3] = band ? 52 : 186
      raw[row + 3 + x * 3] = band ? 18 : 116
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------

const FIRST = ['Ava', 'Ben', 'Chloe', 'Dev', 'Elena', 'Femi', 'Grace', 'Hiro', 'Isla', 'Jonas', 'Kira', 'Leo', 'Maya', 'Noah', 'Olu', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara']
const LAST = ['Adams', 'Baker', 'Chen', 'Diaz', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Ito', 'Jensen', 'Khan', 'Lopez', 'Moreau', 'Nakamura', 'Okafor', 'Patel']
const CITIES = ['Lisbon', 'Austin', 'Osaka', 'Nairobi', 'Toronto', 'Berlin', 'Melbourne']
const PLANS = ['free', 'pro', 'team']

function fullDoc(imageSrc: string) {
  const p = (text: string, marks?: unknown[]) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] })
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Spring walks and short legs' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hi {{first_name|friend}}, this week we test the ' }, { type: 'text', text: 'longest', marks: [{ type: 'bold' }] }, { type: 'text', text: ' trail a corgi can manage. ' }, { type: 'text', text: 'Read the route notes', marks: [{ type: 'link', attrs: { href: 'https://example.com/routes' } }] }, { type: 'text', text: '.' }] },
      { type: 'image', attrs: { src: imageSrc, alt: 'A sunset over the trail', width: 600, caption: 'The view from the top.' } },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'What to pack' }] },
      { type: 'bulletList', content: ['Water bowl', 'Treats', 'A towel for muddy paws'].map((t) => ({ type: 'listItem', content: [p(t)] })) },
      { type: 'orderedList', attrs: { start: 1 }, content: ['Start early', 'Rest often'].map((t) => ({ type: 'listItem', content: [p(t)] })) },
      { type: 'blockquote', content: [p('A tired corgi is a happy corgi.')] },
      { type: 'callout', attrs: { tone: 'info', emoji: '💡' }, content: [p('Trails close at sunset in spring.')] },
      { type: 'button', attrs: { label: 'Plan your walk', href: 'https://example.com/plan', align: 'center' } },
      { type: 'divider' },
      { type: 'spacer', attrs: { height: 24 } },
      { type: 'embed', attrs: { url: 'https://example.com/video', title: 'Trail video', description: 'Three minutes of happy paws.', image: '' } },
      { type: 'codeBlock', content: [{ type: 'text', text: 'distance = legs * patience' }] },
      p('See you next week.', [{ type: 'italic' }]),
    ],
  }
}

interface Seed {
  base: string
  dataDir: string
  accountId: string
  accountDb: string
  newsletter: { id: string; key: string; slug: string }
  second: { id: string }
  campaigns: Record<'draft' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'canceled', string>
  contactId: string
  owner: Client
  member: Client
  admin: Client
  publicPages: Record<string, string>
}

async function seed(base: string, dataDir: string): Promise<Seed> {
  const owner = new Client(base)
  await owner.json('POST', '/api/auth/setup', { name: 'Ada Owner', email: 'owner@example.com', password: PASSWORD })
  const boot = await owner.refreshCsrf()
  const accountId: string = boot.session.current
  const accountDb = path.join(dataDir, 'accounts', `${accountId}.db`)
  const controlDb = path.join(dataDir, 'control.db')

  const nl = await owner.action('newsletters.create', { name: 'The Corgi Weekly' })
  const second = await owner.action('newsletters.create', { name: 'Product notes' })
  const domain = await owner.action('domains.add', { name: 'mail.example.com' })
  verifyDomain(accountDb, domain.id)
  await owner.action('domains.add', { name: 'pending.example.com' })
  await owner.action('newsletters.update', { newsletterId: nl.id, fromName: 'The Corgi Weekly', fromLocal: 'hello', domainId: domain.id, postalAddress: '1 Example Street, Springfield' })
  await owner.action('newsletters.update', { newsletterId: second.id, fromName: 'Product notes', fromLocal: 'notes', domainId: domain.id, postalAddress: '1 Example Street, Springfield' })

  const tags: Record<string, string> = {}
  for (const name of ['VIP', 'Early reader', 'Trail club', 'Podcast']) tags[name] = (await owner.action('tags.create', { newsletterId: nl.id, name })).id
  await owner.action('contactFields.create', { newsletterId: nl.id, key: 'city', label: 'City', type: 'text' })
  await owner.action('contactFields.create', { newsletterId: nl.id, key: 'plan', label: 'Plan', type: 'text' })
  await owner.action('contactFields.create', { newsletterId: nl.id, key: 'dogs', label: 'Dogs', type: 'number' })

  // An import of 3,000 rows: a few duplicates, bad addresses and opt-outs end up skipped.
  const rows: Record<string, string>[] = []
  for (let i = 0; i < 3000; i++) {
    const first = FIRST[i % FIRST.length]!
    const last = LAST[(i * 7) % LAST.length]!
    const tagNames = [i % 15 === 0 ? 'VIP' : '', i % 4 === 0 ? 'Early reader' : '', i % 6 === 0 ? 'Trail club' : ''].filter(Boolean).join(';')
    rows.push({ Email: `${first}.${last}.${i}@example.com`.toLowerCase(), Name: `${first} ${last}`, Status: i % 50 === 7 ? 'unsubscribed' : 'subscribed', Tags: tagNames, City: CITIES[i % CITIES.length]!, Plan: PLANS[i % PLANS.length]!, Dogs: String(1 + (i % 3)) })
  }
  rows.push({ Email: 'not-an-address', Name: 'Broken row', Status: 'subscribed', Tags: '', City: '', Plan: '', Dogs: '' })
  rows.push({ Email: 'ava.adams.0@example.com', Name: 'Duplicate row', Status: 'subscribed', Tags: '', City: '', Plan: '', Dogs: '' })
  const imp = await owner.action('imports.create', { newsletterId: nl.id, mapping: { email: 'Email', name: 'Name', status: 'Status', tags: 'Tags', fields: { city: 'City', plan: 'Plan', dogs: 'Dogs' } }, options: { consent: true } })
  for (let i = 0; i * 500 < rows.length; i++) await owner.action('imports.addChunk', { newsletterId: nl.id, importId: imp.id, seq: i, rows: rows.slice(i * 500, i * 500 + 500) })
  await owner.action('imports.start', { newsletterId: nl.id, importId: imp.id, totalRows: rows.length })
  await until('the import', async () => (await owner.action('imports.get', { newsletterId: nl.id, importId: imp.id })).status === 'completed', 120_000)

  const manual = await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com', name: 'Riley Reader', tags: [tags.VIP, tags.Podcast], fields: { city: 'Lisbon', plan: 'pro', dogs: 2 } })
  for (let i = 0; i < 12; i++) await owner.action('contacts.create', { newsletterId: second.id, email: `notes${i}@example.com`, name: `Notes Reader ${i}` })

  await owner.action('segments.create', { newsletterId: nl.id, name: 'Lisbon VIPs', filter: { all: [{ field: 'tag', id: tags.VIP }, { field: 'custom', key: 'city', op: 'eq', value: 'Lisbon' }] } })
  await owner.action('segments.create', { newsletterId: nl.id, name: 'Pro plan readers', filter: { all: [{ field: 'status', in: ['subscribed'] }, { field: 'custom', key: 'plan', op: 'eq', value: 'pro' }] } })
  await owner.action('segments.create', { newsletterId: nl.id, name: 'Not opened lately', filter: { any: [{ field: 'engagement', op: 'ignoredLast', issues: 3 }, { field: 'lastOpenedAt', op: 'never' }] } })

  const image = await owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: demoPng(), width: 600, height: 300 })
  const imageSrc: string = image.url ?? image.src
  const doc = fullDoc(imageSrc)
  const author = await owner.action('authors.create', { newsletterId: nl.id, name: 'Ada Owner', slug: 'ada', bio: 'Writes about short dogs and long walks.' })

  const make = async (subject: string, audience: unknown = { all: true }) => {
    const c = await owner.action('campaigns.create', { newsletterId: nl.id, subject, doc, audience })
    await owner.action('campaigns.update', { campaignId: c.id, revision: c.revision, previewText: 'Trails, treats and towels.' })
    return c.id as string
  }
  const sent = await make('Spring walks and short legs', { tagIds: [tags.VIP] })
  await owner.action('campaigns.send', { campaignId: sent })
  await until('the sent campaign', async () => (await owner.action('campaigns.get', { campaignId: sent })).status === 'sent', 120_000)

  // Opens, clicks and unsubscribes go through the real tracking routes. Clicks in the first
  // seconds after a send, or without a browser user agent, count as link scanners.
  await sleep(3500)
  const browserHeaders = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }
  const mails = outbox(accountDb, 'subject = ?', 'Spring walks and short legs')
  const tokens = (html: string, prefix: string) => [...html.matchAll(new RegExp(`${prefix}([A-Za-z0-9_.-]+)`, 'g'))].map((m) => m[1]!)
  for (const [i, mail] of mails.entries()) {
    if (i % 2 === 0) for (const t of tokens(mail.html, '/t/o/').slice(0, 1)) await fetch(`${base}/t/o/${t}`, { headers: browserHeaders })
    if (i % 5 === 0) for (const t of tokens(mail.html, '/t/c/').slice(0, 1)) await fetch(`${base}/t/c/${t}`, { redirect: 'manual', headers: browserHeaders })
    if (i % 40 === 3) for (const t of tokens(mail.html, '/u/').slice(0, 1)) await fetch(`${base}/u/${t}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  }
  bounceSome(accountDb, sent, 4)
  await until('the report breakdowns', async () => {
    const r = await owner.action('stats.report', { campaignId: sent })
    return r.updatedAt !== null && r.counts.bounces > 0
  })
  const unsubscribeToken = tokens(mails.at(-1)!.html, '/u/')[0]!
  const keepToken = tokens(mails.at(-1)!.html, '/keep/')[0]

  const draft = await make('Summer camp for herding dogs')
  const scheduled = await make('Rainy day games')
  await owner.action('campaigns.schedule', { campaignId: scheduled, scheduledAt: Date.now() + 3 * 86_400_000 })
  const canceled = await make('Beach day (postponed)')
  await owner.action('campaigns.schedule', { campaignId: canceled, scheduledAt: Date.now() + 86_400_000 })
  await owner.action('campaigns.cancel', { campaignId: canceled })
  const paused = await make('Grooming tips for spring', { segmentId: undefined, all: true })
  await owner.action('campaigns.send', { campaignId: paused })
  await owner.action('campaigns.pause', { campaignId: paused }).catch(async () => {
    await sleep(100)
    await owner.action('campaigns.pause', { campaignId: paused })
  })
  const sending = await make('The great sock heist', { tagIds: [tags['Trail club']] })
  await owner.action('campaigns.send', { campaignId: sending, gradual: true })
  await owner.action('campaigns.create', { newsletterId: second.id, subject: 'Release notes for May' })

  for (const [subject, slug] of [['Why corgis love snow', 'corgis-love-snow'], ['A short history of short legs', 'short-history'], ['Ten trails for small dogs', 'ten-trails']] as const) {
    await owner.action('website.publishPost', { newsletterId: nl.id, subject, slug, source: `Short legs, **big** hearts. A walk through the season with photos and notes.\n\n- Bring water\n- Bring treats\n\n[Read more](https://example.com/more)`, authorId: author.id })
  }
  await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'news.example.com' })

  // Double opt-in signup through the hosted form API, so a confirm link exists.
  const config = await owner.json('GET', `/api/public/subscribe/${nl.key}`)
  await sleep(2100)
  await fetch(`${base}/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'new.reader@example.com', name: 'New Reader', formToken: config.formToken }) })
  const confirmMail = await until('the confirm email', async () => outbox(accountDb, 'to_email = ?', 'new.reader@example.com').find((m) => m.text.includes('/confirm/')))
  const confirmToken = /\/confirm\/([A-Za-z0-9_.-]+)/.exec(confirmMail.text)![1]!

  // Teammates: an admin and a member of the main newsletter, one pending invite.
  const scope = { accountId, newsletterId: nl.id }
  const join = async (email: string, name: string, role: 'admin' | 'member') => {
    await owner.action('team.invite', { ...scope, email, role })
    const mail = await until(`the invite to ${email}`, async () => outbox(controlDb, 'to_email = ?', email).find((m) => m.text.includes('/invite?token=')))
    const token = /\/invite\?token=([^\s"&<]+)/.exec(mail.text)![1]!
    const client = new Client(base)
    await client.json('POST', '/api/auth/signup', { name, email, password: PASSWORD, inviteToken: token })
    await client.refreshCsrf()
    await client.action('team.accept', { token })
    await client.json('POST', '/api/auth/account', { accountId })
    await client.refreshCsrf()
    return client
  }
  const admin = await join('admin@example.com', 'Alex Admin', 'admin')
  const member = await join('member@example.com', 'Morgan Member', 'member')
  await owner.action('team.invite', { ...scope, email: 'pending@example.com', role: 'member' })

  await owner.action('apikeys.create', { name: 'Zapier', access: 'full' })
  await owner.action('apikeys.create', { name: 'Read-only dashboard', access: 'read' }).catch(() => owner.action('apikeys.create', { name: 'Read-only dashboard', access: 'full' }))

  await owner.refreshCsrf()
  return {
    base,
    dataDir,
    accountId,
    accountDb,
    newsletter: { id: nl.id, key: nl.key, slug: nl.slug },
    second: { id: second.id },
    campaigns: { draft, scheduled, sending, paused, sent, canceled },
    contactId: manual.contact?.id ?? manual.id,
    owner,
    member,
    admin,
    publicPages: { unsubscribe: `/u/${unsubscribeToken}`, confirm: `/confirm/${confirmToken}`, ...(keepToken ? { keep: `/keep/${keepToken}` } : {}) },
  }
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

interface Visit {
  name: string
  path: string
  /** Statuses from the app this page is expected to produce, such as the website 404. */
  allow?: number[]
  /** Steps after load, before the screenshot. */
  then?: (page: Page) => Promise<void>
  public?: boolean
}

const problems: string[] = []
const visited: string[] = []

async function newContext(browser: Browser, s: Seed, client: Client | null, theme: Theme, viewport: Viewport): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], colorScheme: theme, deviceScaleFactor: 1, isMobile: viewport === 'phone', hasTouch: viewport === 'phone' })
  await context.addInitScript(([t, key, id]) => {
    try {
      localStorage.setItem('mc-theme', t)
      localStorage.setItem(key, id)
    } catch {}
  }, [theme, `mc-current:${s.accountId}`, s.newsletter.id] as const)
  if (client) await context.addCookies(Object.entries(client.jar.cookies).map(([name, value]) => ({ name, value, url: s.base })))
  return context
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page
    .waitForFunction(() => !document.querySelector('[aria-label="Loading"], .animate-pulse'), null, { timeout: 10_000 })
    .catch(() => problems.push(`${page.url()}: still loading after 10 s`))
  await page.waitForTimeout(150)
}

async function visit(context: BrowserContext, s: Seed, v: Visit, label: string, file: string | null) {
  const page = await context.newPage()
  const origin = new URL(s.base).origin
  const local: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const status = /status of (\d{3})/.exec(msg.text())?.[1]
    if (status && v.allow?.includes(Number(status))) return
    local.push(`console: ${msg.text().split('\n')[0]}`)
  })
  page.on('pageerror', (err) => local.push(`exception: ${err.message}`))
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? ''
    if (failure.includes('ERR_ABORTED') && req.resourceType() !== 'document') return
    local.push(`request failed: ${req.method()} ${req.url()} ${failure}`)
  })
  page.on('response', (res) => {
    if (!res.url().startsWith(origin) || res.status() < 400) return
    if (v.allow?.includes(res.status())) return
    local.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url().slice(origin.length)}`)
  })
  try {
    await page.goto(s.base + v.path, { waitUntil: 'domcontentloaded' })
    await settle(page)
    if (v.then) {
      await v.then(page)
      await settle(page)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (overflow > 1) local.push(`horizontal scroll of ${overflow}px`)
    if (!v.public) {
      // A string, so the bundler's function-name helpers never reach the page.
      const unlabeled = (await page.evaluate(`(() => {
        const named = (el) => !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.labels && el.labels.length) || el.closest('label'))
        const out = []
        for (const el of document.querySelectorAll('input:not([type=hidden]):not(.sr-only), select, textarea')) if (!named(el)) out.push(el.tagName.toLowerCase() + '[' + (el.name || el.type || '') + '] has no label')
        for (const el of document.querySelectorAll('img')) if (!el.hasAttribute('alt')) out.push('img ' + (el.getAttribute('src') || '').slice(0, 40) + ' has no alt')
        for (const el of document.querySelectorAll('button, a[href]')) if (!((el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.labels && el.labels.length) || el.querySelector('img[alt]'))) out.push(el.tagName.toLowerCase() + ' has no name')
        return [...new Set(out)]
      })()`)) as string[]
      for (const u of unlabeled) local.push(`a11y: ${u}`)
      const text = await page.evaluate(() => document.body.innerText)
      if (/something went wrong|unexpected error|\bundefined\b|\bNaN\b|\[object Object\]/i.test(text)) local.push('page shows an error or a raw value')
    }
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // The app scrolls inside <main>; let the page grow so the capture shows everything.
      await page.addStyleTag({ content: 'html, body, #root, #root > div { height: auto !important; min-height: 100vh } main { overflow: visible !important; min-width: 0 } #root > div > div { min-width: 0 } aside > div { position: sticky; top: 0; height: 100vh }' })
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: page.viewportSize()!.width, height } })
    }
  } catch (err) {
    local.push(`failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
  } finally {
    await page.close()
  }
  visited.push(label)
  for (const p of local) problems.push(`${label}: ${p}`)
}

function appPages(s: Seed): Visit[] {
  const c = s.campaigns
  const tab = (name: string) => async (page: Page) => {
    await page.getByRole('tab', { name }).click()
  }
  return [
    { name: 'overview', path: '/' },
    { name: 'campaigns', path: '/campaigns' },
    { name: 'campaign-write', path: `/campaigns/${c.draft}` },
    { name: 'campaign-review', path: `/campaigns/${c.draft}`, then: tab('Review') },
    { name: 'campaign-send', path: `/campaigns/${c.draft}`, then: tab('Send') },
    { name: 'campaign-scheduled', path: `/campaigns/${c.scheduled}` },
    { name: 'campaign-sending', path: `/campaigns/${c.sending}` },
    { name: 'campaign-paused', path: `/campaigns/${c.paused}` },
    { name: 'campaign-canceled', path: `/campaigns/${c.canceled}` },
    { name: 'campaign-report', path: `/campaigns/${c.sent}/report` },
    { name: 'contacts', path: '/contacts' },
    { name: 'contact', path: `/contacts/${s.contactId}` },
    { name: 'segments', path: '/segments' },
    { name: 'imports', path: '/imports' },
    { name: 'website', path: '/website' },
    { name: 'list-health', path: '/list-health' },
    { name: 'notifications', path: '/notifications' },
    { name: 'docs-api', path: '/docs/api' },
    { name: 'welcome', path: '/welcome' },
    { name: 'settings-newsletter', path: '/settings/newsletter' },
    { name: 'settings-design', path: '/settings/design' },
    { name: 'settings-authors', path: '/settings/authors' },
    { name: 'settings-forms', path: '/settings/forms' },
    { name: 'settings-domains', path: '/settings/domains' },
    { name: 'settings-team', path: '/settings/team' },
    { name: 'settings-api', path: '/settings/api' },
    { name: 'settings-account', path: '/settings/account' },
    { name: 'settings-contacts', path: '/settings/contacts' },
    { name: 'settings-suppressions', path: '/settings/suppressions' },
    { name: 'settings-hygiene', path: '/settings/hygiene' },
    { name: 'settings-website', path: '/settings/website' },
    { name: 'admin-setup', path: '/admin/setup' },
    { name: 'admin-accounts', path: '/admin/accounts' },
    { name: 'admin-alerts', path: '/admin/alerts' },
    { name: 'admin-jobs', path: '/admin/jobs' },
    { name: 'admin-settings', path: '/admin/settings' },
    { name: 'admin-email', path: '/admin/email' },
    { name: 'admin-suppressions', path: '/admin/suppressions' },
  ]
}

function signedOutPages(s: Seed): Visit[] {
  const site = `/n/${s.newsletter.slug}`
  return [
    { name: 'signin', path: '/signin' },
    { name: 'signup', path: '/signup' },
    { name: 'reset', path: '/reset' },
    { name: 'invite-invalid', path: '/invite?token=not-a-real-token-at-all', allow: [400, 404, 410] },
    { name: 'public-form', path: `/f/${s.newsletter.key}`, public: true },
    { name: 'public-confirm', path: s.publicPages.confirm!, public: true },
    { name: 'public-unsubscribe', path: s.publicPages.unsubscribe!, public: true },
    ...(s.publicPages.keep ? [{ name: 'public-keep', path: s.publicPages.keep, public: true }] : []),
    { name: 'site-home', path: site, public: true },
    { name: 'site-issue', path: `${site}/corgis-love-snow`, public: true },
    { name: 'site-author', path: `${site}/authors/ada`, public: true },
    { name: 'site-404', path: `${site}/no-such-issue`, public: true, allow: [404] },
  ]
}

function rolePages(s: Seed): Visit[] {
  const c = s.campaigns
  return [
    { name: 'overview', path: '/' },
    { name: 'campaigns', path: '/campaigns' },
    { name: 'campaign-write', path: `/campaigns/${c.draft}` },
    { name: 'campaign-report', path: `/campaigns/${c.sent}/report` },
    { name: 'contacts', path: '/contacts' },
    { name: 'contact', path: `/contacts/${s.contactId}` },
    { name: 'segments', path: '/segments' },
    { name: 'imports', path: '/imports' },
    { name: 'website', path: '/website' },
    { name: 'list-health', path: '/list-health' },
    { name: 'settings-newsletter', path: '/settings/newsletter' },
    { name: 'settings-design', path: '/settings/design' },
    { name: 'settings-authors', path: '/settings/authors' },
    { name: 'settings-forms', path: '/settings/forms' },
    { name: 'settings-domains', path: '/settings/domains' },
    { name: 'settings-team', path: '/settings/team' },
    { name: 'settings-api', path: '/settings/api' },
    { name: 'settings-account', path: '/settings/account' },
    { name: 'settings-contacts', path: '/settings/contacts' },
    { name: 'settings-suppressions', path: '/settings/suppressions' },
    { name: 'settings-hygiene', path: '/settings/hygiene' },
    { name: 'settings-website', path: '/settings/website' },
  ]
}

async function pass(browser: Browser, s: Seed) {
  for (const theme of THEMES) {
    for (const viewport of Object.keys(VIEWPORTS) as Viewport[]) {
      const dir = path.join(shots, theme, viewport)
      const authed = await newContext(browser, s, s.owner, theme, viewport)
      for (const v of appPages(s).filter((v) => !only || only.test(v.name))) await visit(authed, s, v, `${theme}/${viewport}/${v.name}`, path.join(dir, `${v.name}.png`))
      await authed.close()
      const anon = await newContext(browser, s, null, theme, viewport)
      for (const v of signedOutPages(s).filter((v) => !only || only.test(v.name))) await visit(anon, s, v, `${theme}/${viewport}/${v.name}`, path.join(dir, `${v.name}.png`))
      await anon.close()
    }
  }
  for (const [role, client] of [['member', s.member], ['admin', s.admin]] as const) {
    const context = await newContext(browser, s, client, 'light', 'desktop')
    for (const v of rolePages(s).filter((v) => !only || only.test(`${role}-${v.name}`))) await visit(context, s, v, `${role}/${v.name}`, path.join(shots, 'light', 'desktop', `as-${role}-${v.name}`) + '.png')
    await context.close()
  }
}


// ---------------------------------------------------------------------------------------------
// Flows: the main jobs, clicked through as a user would, at desktop width in the light theme.
// ---------------------------------------------------------------------------------------------

async function flows(browser: Browser, s: Seed) {
  const context = await newContext(browser, s, s.owner, 'light', 'desktop')
  const step = async (name: string, run: (page: Page) => Promise<void>) => {
    if (only && !only.test(`flow-${name}`)) return
    await visit(context, s, { name: `flow-${name}`, path: '/', then: run }, `flow/${name}`, path.join(shots, 'light', 'desktop', `flow-${name}.png`))
  }
  const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first().waitFor({ timeout: 10_000 })

  await step('add-contact', async (page) => {
    await page.goto(`${s.base}/contacts`)
    await page.getByRole('button', { name: 'Add contact' }).click()
    await page.getByLabel('Email', { exact: true }).fill('flow.reader@example.com')
    await page.getByLabel('Name', { exact: true }).fill('Flow Reader')
    await page.getByRole('button', { name: 'Add contact' }).last().click()
    await page.getByRole('link', { name: 'flow.reader@example.com' }).waitFor({ timeout: 10_000 })
  })

  await step('segment', async (page) => {
    await page.goto(`${s.base}/segments`)
    await page.getByRole('button', { name: 'New segment' }).click()
    await page.getByLabel('Segment name').fill('Trail club in Osaka')
    await page.getByRole('button', { name: 'Add condition' }).first().click()
    await page.getByLabel('Filter field').last().selectOption({ label: 'Tag' })
    await page.getByLabel('Tag', { exact: true }).last().selectOption({ label: 'Trail club' })
    await page.getByRole('button', { name: 'Save segment' }).click()
    await page.getByText('Trail club in Osaka').first().waitFor({ timeout: 10_000 })
  })

  await step('import', async (page) => {
    await page.goto(`${s.base}/imports`)
    const csv = ['Email,Name,Status', ...Array.from({ length: 40 }, (_, i) => `flow.import.${i}@example.com,Import ${i},subscribed`), 'broken-address,Bad row,subscribed'].join('\n')
    await page.locator('#import-csv').setInputFiles({ name: 'readers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await page.getByLabel(/already confirmed consent/).check()
    await page.getByRole('button', { name: 'Upload and import' }).click()
    await page.getByRole('heading', { name: /Import report/ }).getByText('Completed').waitFor({ timeout: 30_000 })
  })

  let campaignUrl = ''
  await step('write-campaign', async (page) => {
    await page.goto(`${s.base}/campaigns`)
    await page.getByRole('button', { name: 'Write an issue' }).click()
    await page.waitForURL(/\/campaigns\/[^/]+$/)
    campaignUrl = page.url()
    await page.getByLabel('Subject').fill('Autumn leaves and short legs')
    await page.getByLabel('Preview text').fill('Crunchy walks ahead.')
    const editor = page.getByRole('textbox', { name: 'Campaign content' })
    await editor.click()
    await page.keyboard.type('Hello {{first_name|friend}}, autumn is here.')
    const block = async (label: string) => {
      await page.getByRole('button', { name: 'Insert block /' }).click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
    }
    // Typing Enter inside lists, quotes and callouts nests the next block, so start each block on
    // a fresh top-level paragraph at the end, as a writer would with the mouse.
    const fresh = () => page.evaluate(() => {
      const editor = (document.querySelector('.ProseMirror') as unknown as { editor: { state: { doc: { content: { size: number } } }; chain(): any } }).editor
      editor.chain().insertContentAt(editor.state.doc.content.size, { type: 'paragraph' }).focus('end').run()
    })
    for (const label of ['Heading', 'Bulleted list', 'Numbered list', 'Blockquote', 'Code block', 'Callout', 'Divider', 'Rule', 'Spacer']) {
      await fresh()
      await block(label)
      if (!['Divider', 'Rule', 'Spacer'].includes(label)) await page.keyboard.type(`${label} text`)
    }
    await fresh()
    await block('Button')
    await page.getByRole('dialog').getByLabel('Address').fill('https://example.com/autumn')
    await page.getByRole('dialog').getByLabel('Label').fill('Read the guide')
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click()
    await fresh()
    await block('Link card')
    await page.getByRole('dialog').getByLabel('Address').fill('https://example.com/video')
    await page.getByRole('dialog').getByLabel('Label').fill('Autumn video')
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click()
    await fresh()
    await page.getByLabel('Alt text for the next image').fill('Leaves on a trail')
    await page.locator('.mail-editor input[type=file]').setInputFiles({ name: 'leaves.png', mimeType: 'image/png', buffer: Buffer.from(demoPng(), 'base64') })
    await page.locator('.mail-editor img').first().waitFor({ timeout: 15_000 })
    const types = await page.evaluate(() => {
      const editor = (document.querySelector('.ProseMirror') as unknown as { editor: { getJSON(): { content?: { type: string }[] } } }).editor
      return (editor.getJSON().content ?? []).map((n) => n.type)
    })
    const missing = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'callout', 'divider', 'horizontalRule', 'spacer', 'button', 'embed', 'image'].filter((t) => !types.includes(t))
    if (missing.length) throw new Error(`the editor is missing blocks: ${missing.join(', ')}`)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Saved' }).first().waitFor({ timeout: 10_000 })
  })

  await step('image-library', async (page) => {
    if (!campaignUrl) throw new Error('the campaign flow did not create a draft')
    await page.goto(campaignUrl)
    await page.getByRole('button', { name: 'Images', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Images' })
    await dialog.locator('img').first().waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Delete image' }).first().click()
    // The draft uses the image, so the question names it; keep the image.
    const inUse = page.getByRole('dialog', { name: 'This image is still used' })
    await inUse.getByText('Autumn leaves and short legs').waitFor({ timeout: 10_000 })
    await inUse.getByRole('button', { name: 'Cancel' }).click()
    await dialog.locator('img').first().waitFor()
  })

  await step('review-and-send', async (page) => {
    if (!campaignUrl) throw new Error('the campaign flow did not create a draft')
    await page.goto(campaignUrl)
    await page.getByRole('tab', { name: /Review/ }).click()
    await page.getByRole('heading', { name: 'Review your issue' }).waitFor()
    await page.getByRole('tab', { name: /Send/ }).click()
    await page.getByRole('button', { name: 'Send now' }).last().click()
    await page.getByRole('dialog').getByRole('button', { name: /Send/ }).click()
    await page.getByRole('link', { name: 'View report' }).waitFor({ timeout: 60_000 })
    await page.getByRole('link', { name: 'View report' }).click()
    await page.getByText('Unique opens').waitFor()
  })

  await step('invite', async (page) => {
    await page.goto(`${s.base}/settings/team`)
    await page.getByLabel('Email', { exact: true }).fill('new.teammate@example.com')
    await page.getByLabel('Role', { exact: true }).selectOption('admin')
    // The pass runs on the `test` provider, so the page offers the link instead of an email.
    await page.getByRole('button', { name: 'Create invitation' }).click()
    await page.getByRole('textbox', { name: 'Invitation link' }).waitFor({ timeout: 10_000 })
    await page.getByRole('cell', { name: /new\.teammate@example\.com/ }).waitFor({ timeout: 10_000 })
  })

  await step('api-key', async (page) => {
    await page.goto(`${s.base}/settings/api`)
    await page.getByRole('button', { name: 'Create key' }).first().click()
    await page.getByRole('dialog').getByLabel('Name').fill('Flow key')
    await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click()
    await page.getByRole('button', { name: 'I saved my key' }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'I saved my key' }).click()
    await page.getByText('Flow key').waitFor()
  })

  await step('theme', async (page) => {
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Dark' }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await page.getByRole('menuitem', { name: 'Light' }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.keyboard.press('Escape')
  })

  await step('signup-form', async (page) => {
    await page.goto(`${s.base}/settings/forms`)
    await page.getByLabel('Button label').fill('Join the pack')
    await page.getByRole('button', { name: 'Save form' }).click()
    await toast(page, /saved/i).catch(() => page.getByText(/saved/i).first().waitFor({ timeout: 10_000 }))
  })

  await step('website-host', async (page) => {
    await page.goto(`${s.base}/website`)
    await page.getByLabel('Hostname').fill('corgi.example.com')
    await page.getByRole('button', { name: 'Save hostname' }).click()
    await page.getByText(/TXT/).first().waitFor({ timeout: 10_000 })
  })

  await step('create-newsletter', async (page) => {
    await page.goto(`${s.base}/welcome`)
    await page.getByLabel('Name').fill('Dog park digest')
    await page.getByRole('button', { name: 'Create newsletter' }).click()
    await page.waitForURL(`${s.base}/`)
    await page.getByRole('button', { name: /Dog park digest/ }).waitFor({ timeout: 10_000 })
  })

  await step('dialog-keyboard', async (page) => {
    await page.goto(`${s.base}/segments`)
    await page.getByRole('button', { name: 'Delete' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))
    if (!inside) throw new Error('focus left the open dialog')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
  })

  await step('delete-newsletter', async (page) => {
    await page.goto(`${s.base}/settings/newsletter`)
    // Each page load starts on the seeded newsletter; switch to the one the create flow made.
    await page.getByRole('button', { name: 'The Corgi Weekly' }).first().click()
    await page.getByRole('menuitem', { name: /Dog park digest/ }).click()
    await page.getByRole('button', { name: 'Delete Dog park digest', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete Dog park digest?' })
    await dialog.getByLabel('Type Dog park digest to confirm').fill('Dog park digest')
    await dialog.getByRole('button', { name: 'Delete newsletter' }).click()
    await toast(page, 'Newsletter deleted.')
    await page.getByRole('button', { name: 'Delete Dog park digest', exact: true }).waitFor({ state: 'detached', timeout: 10_000 })
  })
  await context.close()
}

// ---------------------------------------------------------------------------------------------
// Before first-run setup, and a short cloud-mode run (billing and the sign-up code step).
// ---------------------------------------------------------------------------------------------

/** A seed with only what `visit` and `newContext` read, for runs without the demo data. */
const bare = (base: string, accountId = 'none'): Seed => ({ base, accountId, newsletter: { id: 'none', key: '', slug: '' } }) as unknown as Seed

async function everyLook(browser: Browser, s: Seed, client: Client | null, pages: Visit[]) {
  for (const theme of THEMES) {
    for (const viewport of Object.keys(VIEWPORTS) as Viewport[]) {
      const context = await newContext(browser, s, client, theme, viewport)
      for (const v of pages.filter((v) => !only || only.test(v.name))) await visit(context, s, v, `${theme}/${viewport}/${v.name}`, path.join(shots, theme, viewport, `${v.name}.png`))
      await context.close()
    }
  }
}

/** The first visitor's page, on an install nobody has set up yet. */
async function preSetup(browser: Browser, base: string) {
  const boot = await (await fetch(`${base}/api/auth/bootstrap`)).json()
  if (!boot.setupRequired) throw new Error('ui-pass: the fresh install does not ask for setup')
  await everyLook(browser, bare(base), null, [{
    name: 'setup',
    path: '/setup',
    then: async (page) => {
      await page.getByRole('button', { name: /create|set up|continue/i }).first().waitFor({ timeout: 10_000 })
    },
  }])
  const after = await (await fetch(`${base}/api/auth/bootstrap`)).json()
  if (!after.setupRequired) throw new Error('ui-pass: visiting /setup changed the install')
}

async function cloudRun(browser: Browser) {
  const dataDir = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-ui-pass-cloud-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const server = startServer(port, dataDir, base, { CLOUD: 'true', BILLING_PROVIDER: 'test', ADMIN_EMAILS: 'cloud.owner@example.com' })
  try {
    await until('the cloud server', async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok, 20_000)
    const owner = new Client(base)
    const pending = await owner.json('POST', '/api/auth/signup', { name: 'Cleo Cloud', email: 'cloud.owner@example.com', password: PASSWORD })
    if (!pending.pending) throw new Error('ui-pass: cloud sign-up did not ask for a code')
    const { code } = await (await fetch(`${base}/api/dev/code?email=cloud.owner%40example.com`)).json()
    await owner.json('POST', '/api/auth/signup/verify', { email: 'cloud.owner@example.com', code })
    const boot = await owner.refreshCsrf()
    const nl = await owner.action('newsletters.create', { name: 'Cloud Corgis' })
    const s = { ...bare(base, boot.session.current), newsletter: { id: nl.id, key: nl.key, slug: nl.slug } } as Seed
    console.log('ui-pass: seeded the cloud install')
    await everyLook(browser, s, owner, [{ name: 'cloud-settings-billing', path: '/settings/billing', then: async (page) => { await page.getByRole('heading', { name: /billing|plan/i }).first().waitFor({ timeout: 10_000 }) } }])
    let n = 0
    await everyLook(browser, s, null, [{
      name: 'cloud-signup-code',
      path: '/signup',
      then: async (page) => {
        n += 1
        await page.getByLabel('Your name').fill('New Reader')
        await page.getByLabel('Email').fill(`cloud.reader.${n}@example.com`)
        await page.getByLabel('Password').fill(PASSWORD)
        await page.getByRole('button', { name: /create|sign up/i }).click()
        await page.getByLabel('Code').waitFor({ timeout: 10_000 })
      },
    }])
  } finally {
    stopServer(server)
    if (process.env.UI_PASS_KEEP) console.log(`ui-pass: cloud data kept in ${dataDir}`)
    else fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(path.join(root, 'dist/index.js')) || !fs.existsSync(path.join(root, 'web/dist/index.html'))) throw new Error('ui-pass: run "npm run build" first')
  fs.mkdirSync(path.join(root, '.audit'), { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-ui-pass-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const server = startServer(port, dataDir, base)
  let browser: Browser | undefined
  try {
    await until('the server', async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok, 20_000)
    browser = await chromium.launch()
    await preSetup(browser, base)
    const s = await seed(base, dataDir)
    console.log('ui-pass: seeded the demo install')
    await pass(browser, s)
    await flows(browser, s)
  } finally {
    stopServer(server)
    if (process.env.UI_PASS_KEEP) console.log(`ui-pass: data kept in ${dataDir}`)
    else fs.rmSync(dataDir, { recursive: true, force: true })
  }
  try {
    if (browser && !serverErrors.length) await cloudRun(browser)
  } finally {
    await browser?.close()
  }
  console.log(`ui-pass: visited ${visited.length} pages`)
  for (const v of visited) console.log(`  ${v}`)
  const all = [...problems, ...serverErrors.map((e) => `server: ${e}`)]
  if (all.length) {
    console.error(`\nui-pass: ${all.length} problems`)
    for (const p of all) console.error(`  ${p}`)
    process.exitCode = 1
  } else console.log('\nui-pass: no console errors, failed requests or app errors')
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.stack}${err.cause ? `\ncause: ${err.cause instanceof Error ? err.cause.stack : String(err.cause)}` : ''}` : err)
  process.exitCode = 1
})
