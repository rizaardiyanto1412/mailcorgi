/**
 * Cloudflare platform. The Worker is the edge; ControlStore and AccountStore are SQLite-backed
 * Durable Objects. Images live in R2 when the IMAGES bucket is bound, else in the account store.
 */
import { DurableObject } from 'cloudflare:workers'
import { parseConfig, type Config } from '../server/core/config.ts'
import { createDb, type Driver } from '../server/core/db.ts'
import { deriveKeys, randomHex, type Keys } from '../server/core/crypto.ts'
import { memoryBlobs, resolveDnsOverHttps, type BlobStore, type Platform, type StoreRef } from '../server/core/platform.ts'
import { storeId } from '../server/core/platform.ts'
import { createStore, createStores, decodeRpcResult, encodeRpcError, type RpcResult, type Store, type Stores } from '../server/core/store.ts'
import { controlRegistry } from '../server/control/modules.ts'
import { controlMigrations } from '../server/control/schema.ts'
import { accountRegistry } from '../server/account/modules.ts'
import { accountMigrations } from '../server/account/schema.ts'
import { createEdge, type Edge } from '../server/edge/index.ts'

interface Env {
  CONTROL: DurableObjectNamespace<ControlStore>
  ACCOUNT: DurableObjectNamespace<AccountStore>
  ASSETS: Fetcher
  IMAGES?: R2Bucket
  CF_VERSION_METADATA?: { id: string; timestamp: string }
  WORKERS_PLAN?: string
  [name: string]: unknown
}

const CODE_HEADER = 'x-mc-code'
const codeStamp = (env: Env) => Date.parse(env.CF_VERSION_METADATA?.timestamp || '') || 0
const stringEnv = (env: Env) => Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
const toBuffer = (value: unknown) => (value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value)

function sqlDriver(ctx: DurableObjectState): Driver {
  const { sql } = ctx.storage
  return {
    all: (query, params) => sql.exec(query, ...params.map(toBuffer)).toArray(),
    run: (query, params) => {
      sql.exec(query, ...params.map(toBuffer)).toArray()
      const row = sql.exec('SELECT last_insert_rowid() AS id, changes() AS changes').one()
      return { id: Number(row.id), changes: Number(row.changes) }
    },
    exec: (query) => void sql.exec(query).toArray(),
    transaction: (fn) => ctx.storage.transactionSync(fn),
  }
}

function r2Blobs(bucket: R2Bucket): BlobStore {
  return {
    put: async (key, bytes, contentType) => void (await bucket.put(key, bytes, { httpMetadata: { contentType } })),
    get: async (key) => {
      const object = await bucket.get(key)
      return object ? { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType || 'application/octet-stream' } : null
    },
    delete: (key) => bucket.delete(key),
    list: async (prefix) => {
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        keys.push(...page.objects.map((o) => o.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return keys
    },
  }
}

const CHUNK = 1024 * 1024
/** Images inside the account store's own SQLite, for installs without an R2 bucket. */
function sqlBlobs(ctx: DurableObjectState): BlobStore {
  const { sql } = ctx.storage
  return {
    async put(key, bytes, contentType) {
      ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM _blobs WHERE key = ?', key)
        for (let seq = 0, at = 0; at < bytes.byteLength || seq === 0; seq++, at += CHUNK) {
          sql.exec('INSERT INTO _blobs (key, seq, content_type, data) VALUES (?, ?, ?, ?)', key, seq, contentType, toBuffer(bytes.subarray(at, at + CHUNK)))
        }
      })
    },
    async get(key) {
      const rows = sql.exec('SELECT content_type, data FROM _blobs WHERE key = ? ORDER BY seq', key).toArray()
      if (rows.length === 0) return null
      const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer))
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.byteLength
      }
      return { bytes: out, contentType: String(rows[0].content_type || 'application/octet-stream') }
    },
    async delete(key) {
      sql.exec('DELETE FROM _blobs WHERE key = ?', key)
    },
    async list(prefix) {
      return sql.exec('SELECT DISTINCT key FROM _blobs WHERE key >= ? AND key < ?', prefix, prefix + '￿').toArray().map((r) => String(r.key))
    },
  }
}

const limitsFor = (env: Env) => ({ subrequestsPerRun: (env.WORKERS_PLAN || '').toLowerCase() === 'free' ? 40 : 900 })

/** RPC to another store through its Durable Object stub. */
function envStores(env: Env): Stores {
  return createStores(async (ref, name, args) => {
    if (ref.kind === 'control') return decodeRpcResult(await env.CONTROL.get(env.CONTROL.idFromName('control')).rpc(name, args))
    return decodeRpcResult(await env.ACCOUNT.get(env.ACCOUNT.idFromName(ref.accountId)).rpc(ref.accountId, name, args))
  })
}

async function keysFor(env: Env, config: Config, own?: () => string): Promise<Keys> {
  if (config.secret) return deriveKeys(config.secret)
  if (own) return deriveKeys(own())
  const { master } = await envStores(env).control.masterKey({})
  return deriveKeys(master)
}

abstract class BaseStore extends DurableObject<Env> {
  protected store: Promise<Store> | null = null
  protected config: Config

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.config = parseConfig(stringEnv(env))
  }

  protected abstract ref(): StoreRef

  protected async build(): Promise<Store> {
    const ref = this.ref()
    const keys = await keysFor(this.env, this.config, ref.kind === 'control' ? () => this.ownMaster() : undefined)
    const blobs = this.env.IMAGES ? r2Blobs(this.env.IMAGES) : ref.kind === 'account' ? sqlBlobs(this.ctx) : memoryBlobs()
    const platform: Platform = {
      blobs,
      fetch: (input, init) => fetch(input, init),
      setAlarm: async (_ref, at) => {
        if (at === null) await this.ctx.storage.deleteAlarm()
        else await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 50))
      },
      resolveDns: (name, type) => resolveDnsOverHttps(fetch, name, type),
      waitUntil: (p) => this.ctx.waitUntil(p),
      limits: limitsFor(this.env),
    }
    const registry = ref.kind === 'control' ? controlRegistry : accountRegistry
    const migrations = ref.kind === 'control' ? controlMigrations : accountMigrations
    return createStore(registry, migrations, { ref, db: createDb(sqlDriver(this.ctx)), platform, stores: envStores(this.env), config: this.config, keys, now: Date.now })
  }

  private ownMaster(): string {
    let secret = this.ctx.storage.kv.get<string>('master')
    if (!secret) {
      secret = randomHex(32)
      this.ctx.storage.kv.put('master', secret)
    }
    return secret
  }

  protected ready(): Promise<Store> {
    if (!this.store) this.store = this.build()
    return this.store
  }

  async fetch(request: Request): Promise<Response> {
    // After a deploy this object keeps old code while a request is in flight. When the Worker in
    // front says it runs newer code, restart on a read, which the Worker repeats.
    const mine = codeStamp(this.env)
    const theirs = Number(request.headers.get(CODE_HEADER) || 0)
    if (mine && theirs > mine && (request.method === 'GET' || request.method === 'HEAD')) this.ctx.abort('A newer version was deployed.')
    const store = await this.ready()
    const response = await store.fetch(request)
    const out = new Response(response.body, response)
    out.headers.set(CODE_HEADER, String(mine))
    return out
  }

  protected async call(name: string, args: unknown): Promise<RpcResult> {
    try {
      const store = await this.ready()
      return { ok: true, result: await store.rpc(name, args) }
    } catch (err) {
      return encodeRpcError(err)
    }
  }

  async alarm(): Promise<void> {
    try {
      const store = await this.ready()
      await store.alarm()
    } catch (err) {
      console.error('[alarm]', err)
    }
  }
}

export class ControlStore extends BaseStore {
  protected ref(): StoreRef {
    return { kind: 'control' }
  }
  rpc(name: string, args: unknown): Promise<RpcResult> {
    return this.call(name, args)
  }
}

export class AccountStore extends BaseStore {
  private accountId: string | null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.accountId = ctx.storage.kv.get<string>('accountId') ?? null
  }

  /** The object learns its own account id from the first caller and keeps it for alarms. */
  private learn(accountId: string | null) {
    if (!accountId || this.accountId) return
    this.accountId = accountId
    this.ctx.storage.kv.put('accountId', accountId)
  }

  protected ref(): StoreRef {
    if (!this.accountId) throw new Error('This account store has not been told its account id yet.')
    return { kind: 'account', accountId: this.accountId }
  }

  async fetch(request: Request): Promise<Response> {
    this.learn(request.headers.get('x-mc-account'))
    return super.fetch(request)
  }

  rpc(accountId: string, name: string, args: unknown): Promise<RpcResult> {
    this.learn(accountId)
    return this.call(name, args)
  }
}

let edge: Edge | null = null
let keysPromise: Promise<Keys> | null = null

function edgeFor(env: Env): Edge {
  if (edge) return edge
  const config = parseConfig(stringEnv(env))
  const mine = codeStamp(env)
  const stub = (ref: StoreRef) => (ref.kind === 'control' ? env.CONTROL.get(env.CONTROL.idFromName('control')) : env.ACCOUNT.get(env.ACCOUNT.idFromName(ref.accountId)))
  edge = createEdge({
    config,
    keys: () => (keysPromise ??= keysFor(env, config)),
    stores: envStores(env),
    async storeFetch(ref, request) {
      const headers = new Headers(request.headers)
      headers.set(CODE_HEADER, String(mine))
      const send = () => stub(ref).fetch(new Request(request, { headers }))
      try {
        return await send()
      } catch (err) {
        // The object restarted to load new code. A read can be repeated at once.
        if (request.method !== 'GET' && request.method !== 'HEAD') throw err
        return send()
      }
    },
    blobs: env.IMAGES ? r2Blobs(env.IMAGES) : null,
    assets: (request) => env.ASSETS.fetch(request),
    now: Date.now,
  })
  void storeId
  return edge
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return edgeFor(env).fetch(request)
  },
}
