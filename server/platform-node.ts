/**
 * Node.js platform: SQLite files under DATA_DIR, images on disk, a secret key file, and a
 * 1-second scheduler that fires store alarms. The only server file that may use Node APIs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Config } from './core/config.ts'
import { createDb, createMeter, isWriteRefused, meterStatement, type Driver, type Meter, type SqlValue } from './core/db.ts'
import { deriveKeys, randomHex, type Keys } from './core/crypto.ts'
import { dnsResolver, resolveDnsOverHttps, type BlobStore, type Platform, type StoreRef } from './core/platform.ts'
import { storeId } from './core/platform.ts'
import { createStore, createStores, type Store, type Stores } from './core/store.ts'
import { controlRegistry } from './control/modules.ts'
import { controlMigrations } from './control/schema.ts'
import { accountRegistry } from './account/modules.ts'
import { accountMigrations } from './account/schema.ts'
import { AppError } from './core/http.ts'
import { isAccountId } from './core/ids.ts'
import { createEdge, type Edge } from './edge/index.ts'
import { isSpaRoute } from './edge/assets.ts'

export interface NodeOptions {
  config: Config
  now?: () => number
  fetch?: typeof fetch
  resolveDns?: Platform['resolveDns']
  assets?: (request: Request) => Promise<Response>
  log?: (line: string) => void
  /** Tests: when this returns true, every row write and alarm fails as Cloudflare's quota does. */
  refuseWrites?: () => boolean
}

export interface NodeApp {
  config: Config
  keys: Keys
  platform: Platform
  stores: Stores
  edge: Edge
  control: Store
  account(id: string): Store
  accountIds(): string[]
  /** Run every alarm that is due. The scheduler calls this each second. */
  tick(): Promise<void>
  startScheduler(): void
  stopScheduler(): void
  close(): void
}

/** What Cloudflare answers once the day's row writes are used up; the test switch throws the same text. */
export const WRITE_REFUSED_MESSAGE = 'Exceeded allowed rows written in Durable Objects free tier.'
const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i

export function openDriver(file: string, opts: { meter?: Meter; refuseWrites?: () => boolean } = {}): { driver: Driver; close(): void; meter: Meter } {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  const meter = opts.meter ?? createMeter()
  const cache = new Map<string, StatementSync>()
  const stmt = (sql: string) => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }
  const refuse = (sql: string) => {
    if (opts.refuseWrites?.() && WRITES.test(sql)) throw new Error(WRITE_REFUSED_MESSAGE)
  }
  type Bind = Exclude<SqlValue, never>[]
  const driver: Driver = {
    all: (sql, params) => {
      refuse(sql)
      const rows = stmt(sql).all(...(params as Bind)) as any[]
      meterStatement(meter, sql, 0, rows.length)
      return rows
    },
    run: (sql, params) => {
      refuse(sql)
      const r = stmt(sql).run(...(params as Bind))
      meterStatement(meter, sql, Number(r.changes), 0)
      return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }
    },
    exec: (sql) => {
      refuse(sql)
      db.exec(sql)
    },
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
  return { driver, close: () => db.close(), meter }
}

const isPrivatePeer = (ip: string) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(ip)

/** Whether the socket peer is a proxy named in `TRUST_PROXY`, so its forwarding headers count. */
export function trustsProxy(trust: string[], peer: string | null): boolean {
  const socket = (peer ?? '').replace(/^::ffff:/i, '').toLowerCase()
  if (!socket || trust.length === 0) return false
  return trust.includes(socket) || (trust.includes('true') && isPrivatePeer(socket))
}

/** A trusted proxy appends the client it saw last; without one the socket peer is the client. */
export function nodeClientIp(request: Request, peer: string | null, trust: string[] = []): string {
  const socket = (peer ?? '').replace(/^::ffff:/i, '')
  if (!trustsProxy(trust, peer)) return socket
  return (request.headers.get('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean).at(-1) ?? socket
}

export function diskBlobs(root: string): BlobStore {
  const fileOf = (key: string) => {
    const file = path.join(root, key)
    return file.startsWith(root + path.sep) && !key.includes('..') ? file : null
  }
  return {
    separate: true,
    async put(key, bytes, contentType) {
      const file = fileOf(key)
      if (!file) throw new Error('Bad blob key.')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
      fs.writeFileSync(file + '.type', contentType)
    },
    async get(key) {
      const file = fileOf(key)
      if (!file || !fs.existsSync(file)) return null
      const contentType = fs.existsSync(file + '.type') ? fs.readFileSync(file + '.type', 'utf8') : 'application/octet-stream'
      return { bytes: new Uint8Array(fs.readFileSync(file)), contentType }
    },
    async delete(key) {
      const file = fileOf(key)
      if (!file) return
      fs.rmSync(file, { force: true })
      fs.rmSync(file + '.type', { force: true })
    },
    async list(prefix) {
      const dir = fileOf(prefix) ?? root
      if (!fs.existsSync(dir)) return []
      const out: string[] = []
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (!entry.name.endsWith('.type')) out.push(path.relative(root, full).split(path.sep).join('/'))
        }
      }
      walk(dir)
      return out.filter((k) => k.startsWith(prefix))
    },
  }
}

function masterKey(config: Config, dataDir: string): string {
  if (config.secret) return config.secret
  const file = path.join(dataDir, 'secret.key')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  const secret = randomHex(32)
  fs.writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

/** Serve the built web app with an index.html fallback for client-side routes. */
export function nodeAssets(webRoot: string): (request: Request) => Promise<Response> {
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain; charset=utf-8',
  }
  return async (request) => {
    let decoded: string
    try {
      decoded = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const requested = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
    let file = path.join(webRoot, requested)
    if (!file.startsWith(webRoot)) return new Response('Not found', { status: 404 })
    // `_headers` is Cloudflare's asset config, not a page.
    if (path.basename(file) === '_headers') return new Response('Not found', { status: 404 })
    const isAsset = fs.existsSync(file) && fs.statSync(file).isFile()
    if (!isAsset) {
      if (!isSpaRoute(requested.split(path.sep).join('/'))) return new Response('Not found', { status: 404 })
      file = path.join(webRoot, 'index.html')
      if (!fs.existsSync(file)) return new Response('The web app is not built yet. Run "npm run build", or use "npm run dev" and open the Vite URL.', { status: 503 })
    }
    return new Response(fs.readFileSync(file), {
      headers: {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': requested.startsWith('/assets/') && isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  }
}

export async function createNodeApp(opts: NodeOptions): Promise<NodeApp> {
  const { config } = opts
  const now = opts.now ?? Date.now
  const fetchFn = opts.fetch ?? fetch
  const log = opts.log ?? ((line: string) => console.log(line))
  const dataDir = path.resolve(config.dataDir)
  const accountsDir = path.join(dataDir, 'accounts')
  const imagesDir = path.join(dataDir, 'images')
  for (const dir of [dataDir, accountsDir, imagesDir]) fs.mkdirSync(dir, { recursive: true })

  const keys = await deriveKeys(masterKey(config, dataDir))
  const alarms = new Map<string, number>()
  const meters = new Map<string, Meter>()
  const platform: Platform = {
    blobs: diskBlobs(imagesDir),
    fetch: fetchFn,
    async setAlarm(ref, at) {
      if (opts.refuseWrites?.()) throw new Error(WRITE_REFUSED_MESSAGE)
      meterStatement(meters.get(storeId(ref))!, 'setAlarm', 1, 0)
      if (at === null) alarms.delete(storeId(ref))
      else alarms.set(storeId(ref), at)
    },
    async getAlarm(ref) {
      return alarms.get(storeId(ref)) ?? null
    },
    resolveDns: opts.resolveDns ?? dnsResolver(config.testDns, (name, type) => resolveDnsOverHttps(fetchFn, name, type)),
    waitUntil: (p) => void p.catch((err) => console.error('[waitUntil]', err)),
    limits: { subrequestsPerRun: 900 },
    async destroyStore(ref) {
      if (ref.kind !== 'account') throw new AppError('invalid_store', 'The control store cannot be destroyed.', 400)
      const store = accounts.get(ref.accountId)
      if (store) {
        accounts.delete(ref.accountId)
        alarms.delete(ref.accountId)
        closers.get(store)?.()
        closers.delete(store)
      }
      const file = path.join(accountsDir, `${ref.accountId}.db`)
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
    },
  }

  const closers = new Map<Store, () => void>()
  const stores = createStores((ref, name, args) => (ref.kind === 'account' && name === 'bootstrap' ? account(ref.accountId, true) : storeFor(ref)).rpc(name, args))
  const open = (ref: StoreRef): Store => {
    const file = ref.kind === 'control' ? path.join(dataDir, 'control.db') : path.join(accountsDir, `${ref.accountId}.db`)
    const meter = createMeter()
    meters.set(storeId(ref), meter)
    const { driver, close } = openDriver(file, { meter, refuseWrites: opts.refuseWrites })
    const registry = ref.kind === 'control' ? controlRegistry : accountRegistry
    const migrations = ref.kind === 'control' ? controlMigrations : accountMigrations
    const store = createStore(registry, migrations, { ref, db: createDb(driver), platform, stores, config, keys, now, meter })
    closers.set(store, close)
    return store
  }
  const control = open({ kind: 'control' })
  const accounts = new Map<string, Store>()
  const accountExists = (id: string) => !!control.ctx.db.get('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL', id)
  const accountIds = () => [...accounts.keys()].filter(accountExists)
  const account = (id: string, provision = false) => {
    if (!isAccountId(id)) throw new AppError('not_found', 'Not found.', 404)
    if (!provision && (!accountExists(id) || !fs.existsSync(path.join(accountsDir, `${id}.db`)))) {
      throw new AppError('not_found', 'Account store is not provisioned.', 404)
    }
    let store = accounts.get(id)
    if (!store) {
      store = open({ kind: 'account', accountId: id })
      accounts.set(id, store)
    }
    return store
  }
  const storeFor = (ref: StoreRef) => (ref.kind === 'control' ? control : account(ref.accountId))
  // Every account store opens at start so a job that was due during the downtime runs now.
  for (const entry of fs.readdirSync(accountsDir)) if (entry.endsWith('.db') && isAccountId(entry.slice(0, -3)) && accountExists(entry.slice(0, -3))) account(entry.slice(0, -3))

  const edge = createEdge({
    config,
    fetch: (input, init) => platform.fetch(input, init),
    keys: async () => keys,
    stores,
    storeFetch: (ref, request) => storeFor(ref).fetch(request),
    blobs: platform.blobs,
    assets: opts.assets ?? (async () => new Response('Not found', { status: 404 })),
    now,
    meter: async (ref) => storeFor(ref).meter,
    clientIp: (request, peer) => nodeClientIp(request, peer, config.trustProxy),
    trustsProxy: (peer) => trustsProxy(config.trustProxy, peer),
  })

  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      await Promise.all([control, ...accountIds().map((id) => account(id))].map((store) => store.rearm().catch(() => {})))
      const due = [...alarms.entries()].filter(([, at]) => at <= now()).map(([id]) => id)
      for (const id of due) {
        alarms.delete(id)
        if (id !== 'control' && !accountExists(id)) continue
        try {
          await storeFor(id === 'control' ? { kind: 'control' } : { kind: 'account', accountId: id }).alarm()
        } catch (err) {
          if (!isWriteRefused(err)) console.error('[alarm]', id, err)
        }
      }
    } finally {
      ticking = false
    }
  }
  let timer: ReturnType<typeof setInterval> | null = null

  log(`Data directory: ${dataDir}`)
  return {
    config,
    keys,
    platform,
    stores,
    edge,
    control,
    account,
    accountIds,
    tick,
    startScheduler() {
      if (timer) return
      timer = setInterval(() => void tick(), 1000)
      timer.unref?.()
    },
    stopScheduler() {
      if (timer) clearInterval(timer)
      timer = null
    },
    close() {
      if (timer) clearInterval(timer)
      timer = null
      for (const close of closers.values()) close()
      closers.clear()
    },
  }
}
