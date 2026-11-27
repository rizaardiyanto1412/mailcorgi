import { Hono } from 'hono'
import type { Db, Meter, Migration } from './db.ts'
import { createMeter, isWriteRefused, migrate } from './db.ts'
import type { Platform, StoreRef } from './platform.ts'
import { storeId } from './platform.ts'
import type { Config } from './config.ts'
import type { Keys } from './crypto.ts'
import { openEnvelope } from './crypto.ts'
import { Budget, createJobs, nextWakeAt, runDueJobs, type Jobs } from './jobs.ts'
import { pruneRates } from './ratelimit.ts'
import { runAction, type Actor, type Registry } from './actions.ts'
import { AppError, asAppError, errorResponse, jsonNotFound, readJson, withSecurityHeaders, type StoreEnv } from './http.ts'
import type { ControlRpc } from '../control/rpc.ts'
import type { AccountRpc } from '../account/rpc.ts'

export interface Stores {
  control: ControlRpc
  account(id: string): AccountRpc
}

export interface StoreCtx {
  kind: 'control' | 'account'
  accountId: string | null
  db: Db
  platform: Platform
  stores: Stores
  config: Config
  keys: Keys
  now(): number
  jobs: Jobs
  registry: Registry
  /** Rows written and read since this store instance opened (see `Meter`). */
  meter: Meter
  /** Writes that may wait: queued here, they run in one batch on the next alarm or after the next write. */
  later: Later
  /** Per-instance scratch for state that may be lost on a restart (counters, caches). */
  memory: Map<string, unknown>
}

export interface Later {
  /** Queue a flush under `key`; a repeat replaces it, so a module aggregates in memory and writes the total once. */
  add(key: string, flush: (ctx: StoreCtx) => void): void
  pending(): boolean
}

export interface StoreDeps {
  ref: StoreRef
  db: Db
  platform: Platform
  stores: Stores
  config: Config
  keys: Keys
  now: () => number
  meter?: Meter
}

export interface Store {
  ctx: StoreCtx
  ref: StoreRef
  fetch(request: Request): Promise<Response>
  rpc(name: string, args: unknown): Promise<unknown>
  alarm(): Promise<void>
  nextWakeAt(): number | null
  /** Re-arm the alarm when the next wake time changed. Every entry point does this on the way out. */
  rearm(): Promise<void>
  /** Run the deferred writes now. */
  flush(): void
  meter: Meter
  /** When the platform last refused a row write, or null. In memory only. */
  writesRefusedAt(): number | null
}

/** How long one alarm run may take before handlers yield. */
const ALARM_RUN_MS = 20_000
/** How long deferred writes may wait before an alarm flushes them. */
export const FLUSH_AFTER_MS = 60_000
/** An alarm already armed this much later than that still carries the flush, so arming costs nothing extra. */
const FLUSH_SLACK_MS = 5 * 60_000
export const ACTOR_HEADER = 'x-mc-actor'
export const ACTOR_TTL_MS = 60_000

export interface ActorEnvelope {
  actor: Actor
  aud: string
  exp: number
}

/** Turn a thrown error into a JSON result that crosses the RPC boundary intact. */
export type RpcResult = { ok: true; result: unknown } | { ok: false; code: string; message: string; status: number; details?: unknown }

export const encodeRpcError = (err: unknown): RpcResult => {
  const known = asAppError(err)
  return known ? { ok: false, code: known.code, message: known.message, status: known.status, details: known.details } : { ok: false, code: 'internal', message: err instanceof Error ? err.message : String(err), status: 500 }
}

export function decodeRpcResult(result: RpcResult): unknown {
  if (result.ok) return result.result
  throw new AppError(result.code, result.message, result.status, result.details)
}

export function createStore(registry: Registry, migrations: readonly Migration[], deps: StoreDeps): Store {
  const { db, platform, ref } = deps
  const id = storeId(ref)
  const meter = deps.meter ?? createMeter()
  migrate(db, [...migrations, ...registry.migrations], deps.now)

  let refusedAt: number | null = null
  const noteRefused = (err: unknown) => {
    if (isWriteRefused(err)) refusedAt = deps.now()
  }

  const flushes = new Map<string, (ctx: StoreCtx) => void>()
  let flushDueAt: number | null = null
  const later: Later = {
    add(key, flush) {
      flushes.set(key, flush)
      // The entry point that called this re-arms on the way out, so the alarm is set once.
      if (flushDueAt === null) flushDueAt = deps.now() + FLUSH_AFTER_MS
    },
    pending: () => flushes.size > 0,
  }
  const flush = () => {
    if (!flushes.size) return
    const batch = [...flushes.entries()]
    flushes.clear()
    flushDueAt = null
    for (const [key, fn] of batch) {
      try {
        fn(ctx)
      } catch (err) {
        noteRefused(err)
        // The batch is lost on a refused write; the next views start a new one.
        if (!isWriteRefused(err)) console.error('[flush]', key, err)
      }
    }
  }
  const nextWake = (): number | null => {
    const jobsAt = nextWakeAt(db)
    if (flushDueAt === null) return jobsAt
    if (jobsAt !== null && jobsAt <= flushDueAt + FLUSH_SLACK_MS) return jobsAt
    return flushDueAt
  }

  // The time the platform holds, so a store only pays for `setAlarm` when the time changes.
  // `undefined` means "ask the platform", as after a restart.
  let armed: number | null | undefined = undefined
  let arming: Promise<void> | null = null
  const rearm = (): Promise<void> => {
    // Serialize writes and read the queue after earlier writes finish, so the last word wins.
    if (arming) return arming.catch(() => {}).then(rearm)
    const write = async () => {
      const desired = nextWake()
      if (armed === undefined) armed = await platform.getAlarm(ref)
      if (desired === armed) return
      try {
        await platform.setAlarm(ref, desired)
        armed = desired
      } catch (err) {
        armed = undefined
        noteRefused(err)
        throw err
      }
    }
    arming = write().finally(() => { arming = null })
    return arming
  }
  // A refused `setAlarm` must not turn a finished request into an error; the next entry retries.
  const rearmQuietly = () => rearm().catch((err) => { if (!isWriteRefused(err)) console.error('[alarm]', err) })
  const jobs = createJobs(db, deps.now, () => void rearmQuietly())

  const ctx: StoreCtx = {
    kind: ref.kind,
    accountId: ref.kind === 'account' ? ref.accountId : null,
    db,
    platform,
    stores: deps.stores,
    config: deps.config,
    keys: deps.keys,
    now: deps.now,
    jobs,
    registry,
    meter,
    later,
    memory: new Map(),
  }

  // Without APP_URL only the control store learns the address (at sign-in). An account store has its
  // own config, so it reads the learned value before building any link.
  const learnAppUrl = async () => {
    if (ref.kind !== 'account' || ctx.config.appUrl) return
    const values = await deps.stores.control.getInstallSettings({ keys: ['app_url'] })
    if (values.app_url) ctx.config.appUrl = values.app_url.replace(/\/+$/, '')
  }

  const app = new Hono<StoreEnv>()
  app.use('*', async (c, next) => {
    c.set('ctx', ctx)
    const envelope = c.req.header(ACTOR_HEADER)
    let actor: Actor | null = null
    if (envelope) {
      const opened = await openEnvelope<ActorEnvelope>(deps.keys.session, envelope)
      if (!opened || opened.aud !== id || opened.exp <= deps.now()) return c.json({ error: 'The request could not be verified.', code: 'bad_envelope' }, 401)
      actor = opened.actor
    }
    c.set('actor', actor)
    await next()
  })
  app.onError((err) => {
    noteRefused(err)
    return errorResponse(err)
  })
  app.post('/api/actions/:name', async (c) => {
    const actor = c.get('actor')
    if (!actor) return c.json({ error: 'Sign in to continue.', code: 'unauthorized' }, 401)
    if (registry.actions.get(c.req.param('name'))?.restOnly) return c.json({ error: `Unknown action ${c.req.param('name')}.`, code: 'unknown_action' }, 404)
    const input = await readJson(c)
    const result = await runAction(ctx, c.req.param('name'), input, actor)
    return c.json(result ?? null)
  })
  for (const mount of registry.routes) mount(app)
  app.all('*', (c) => jsonNotFound(c))

  // Deferred writes ride along with an invocation that wrote anyway; an idle store waits for the alarm.
  const leave = async (wroteBefore: number) => {
    if (flushes.size && meter.writes > wroteBefore) flush()
    await rearmQuietly()
  }

  const store: Store = {
    ctx,
    ref,
    meter,
    writesRefusedAt: () => refusedAt,
    flush,
    async fetch(request) {
      const before = meter.writes
      try {
        await learnAppUrl()
        return withSecurityHeaders(await app.fetch(request))
      } finally {
        await leave(before)
      }
    },
    async rpc(name, args) {
      const before = meter.writes
      try {
        const fn = registry.rpc.get(name)
        if (!fn) throw new AppError('unknown_rpc', `Unknown RPC ${name} on the ${ref.kind} store.`, 404)
        if (name !== 'bootstrap') await learnAppUrl()
        return await fn(ctx, args)
      } catch (err) {
        noteRefused(err)
        throw err
      } finally {
        await leave(before)
      }
    },
    async alarm() {
      // The platform consumed the alarm it held; the end of this run arms the next one.
      armed = null
      const budget = new Budget(deps.now() + ALARM_RUN_MS, platform.limits.subrequestsPerRun, deps.now)
      try {
        await learnAppUrl()
        flush()
        await runDueJobs(ctx, budget, {
          onDead: (ctx, job, error) => {
            if (job.kind === 'alerts.raise') return
            ctx.jobs.enqueue('alerts.raise', { kind: 'job_dead', title: `Job ${job.kind} failed ${job.attempts} times`, body: error, jobId: job.id })
          },
        })
        for (const fn of [...registry.maintenance, (ctx: StoreCtx) => pruneRates(ctx.db, deps.now())]) {
          try {
            fn(ctx)
          } catch (err) {
            noteRefused(err)
            if (!isWriteRefused(err)) console.error('[maintenance]', err)
          }
        }
      } catch (err) {
        noteRefused(err)
        throw err
      } finally {
        // A refused write here means the platform must retry the alarm itself, so this one may throw.
        await rearm().catch((err) => { if (!isWriteRefused(err)) console.error('[alarm]', err) })
      }
    },
    nextWakeAt: nextWake,
    rearm,
  }
  void rearmQuietly()
  return store
}

/** A `Stores` object that forwards every method call to `call(ref, name, args)`. */
export function createStores(call: (ref: StoreRef, name: string, args: unknown) => Promise<unknown>): Stores {
  const proxyFor = (ref: StoreRef) =>
    new Proxy({} as Record<string, (args: unknown) => Promise<unknown>>, {
      get: (_target, name) => (typeof name === 'string' ? (args: unknown) => call(ref, name, args) : undefined),
    })
  const control = proxyFor({ kind: 'control' }) as unknown as ControlRpc
  const accounts = new Map<string, AccountRpc>()
  return {
    control,
    account(id) {
      let p = accounts.get(id)
      if (!p) {
        p = proxyFor({ kind: 'account', accountId: id }) as unknown as AccountRpc
        accounts.set(id, p)
      }
      return p
    },
  }
}
