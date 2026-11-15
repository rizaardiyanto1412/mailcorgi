import { Hono } from 'hono'
import type { Db, Migration } from './db.ts'
import { migrate } from './db.ts'
import type { Platform, StoreRef } from './platform.ts'
import { storeId } from './platform.ts'
import type { Config } from './config.ts'
import type { Keys } from './crypto.ts'
import { openEnvelope } from './crypto.ts'
import { Budget, createJobs, nextWakeAt, runDueJobs, type Jobs } from './jobs.ts'
import { runAction, type Actor, type Registry } from './actions.ts'
import { AppError, errorResponse, jsonNotFound, readJson, withSecurityHeaders, type StoreEnv } from './http.ts'
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
}

export interface StoreDeps {
  ref: StoreRef
  db: Db
  platform: Platform
  stores: Stores
  config: Config
  keys: Keys
  now: () => number
}

export interface Store {
  ctx: StoreCtx
  ref: StoreRef
  fetch(request: Request): Promise<Response>
  rpc(name: string, args: unknown): Promise<unknown>
  alarm(): Promise<void>
  nextWakeAt(): number | null
  /** Re-arm the alarm from the jobs table. Every entry point does this on the way out. */
  rearm(): Promise<void>
}

/** How long one alarm run may take before handlers yield. */
const ALARM_RUN_MS = 20_000
export const ACTOR_HEADER = 'x-mc-actor'
export const ACTOR_TTL_MS = 60_000

export interface ActorEnvelope {
  actor: Actor
  aud: string
  exp: number
}

/** Turn a thrown error into a JSON result that crosses the RPC boundary intact. */
export type RpcResult = { ok: true; result: unknown } | { ok: false; code: string; message: string; status: number; details?: unknown }

export const encodeRpcError = (err: unknown): RpcResult =>
  err instanceof AppError ? { ok: false, code: err.code, message: err.message, status: err.status, details: err.details } : { ok: false, code: 'internal', message: err instanceof Error ? err.message : String(err), status: 500 }

export function decodeRpcResult(result: RpcResult): unknown {
  if (result.ok) return result.result
  throw new AppError(result.code, result.message, result.status, result.details)
}

export function createStore(registry: Registry, migrations: readonly Migration[], deps: StoreDeps): Store {
  const { db, platform, ref } = deps
  const id = storeId(ref)
  migrate(db, [...migrations, ...registry.migrations], deps.now)

  let arming: Promise<void> | null = null
  const rearm = (): Promise<void> => {
    // Serialize writes and read the queue after earlier writes finish. Every invocation repairs
    // a missing alarm, including when a previous registration failed or an alarm was consumed.
    if (arming) return arming.catch(() => {}).then(rearm)
    const write = async () => { await platform.setAlarm(ref, nextWakeAt(db)) }
    arming = write().finally(() => { arming = null })
    return arming
  }
  const jobs = createJobs(db, deps.now, () => void rearm().catch((err) => console.error('[alarm]', err)))

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
  app.onError((err) => errorResponse(err))
  app.post('/api/actions/:name', async (c) => {
    const actor = c.get('actor')
    if (!actor) return c.json({ error: 'Sign in to continue.', code: 'unauthorized' }, 401)
    const input = await readJson(c)
    const result = await runAction(ctx, c.req.param('name'), input, actor)
    return c.json(result ?? null)
  })
  for (const mount of registry.routes) mount(app)
  app.all('*', (c) => jsonNotFound(c))

  const store: Store = {
    ctx,
    ref,
    async fetch(request) {
      try {
        await learnAppUrl()
        return withSecurityHeaders(await app.fetch(request))
      } finally {
        await rearm()
      }
    },
    async rpc(name, args) {
      try {
        const fn = registry.rpc.get(name)
        if (!fn) throw new AppError('unknown_rpc', `Unknown RPC ${name} on the ${ref.kind} store.`, 404)
        if (name !== 'bootstrap') await learnAppUrl()
        return await fn(ctx, args)
      } finally {
        await rearm()
      }
    },
    async alarm() {
      const budget = new Budget(deps.now() + ALARM_RUN_MS, platform.limits.subrequestsPerRun, deps.now)
      try {
        await learnAppUrl()
        await runDueJobs(ctx, budget, {
          onDead: (ctx, job, error) => {
            if (job.kind === 'alerts.raise') return
            ctx.jobs.enqueue('alerts.raise', { kind: 'job_dead', title: `Job ${job.kind} failed ${job.attempts} times`, body: error, jobId: job.id })
          },
        })
        for (const fn of registry.maintenance) {
          try {
            fn(ctx)
          } catch (err) {
            console.error('[maintenance]', err)
          }
        }
      } finally {
        await rearm()
      }
    },
    nextWakeAt: () => nextWakeAt(db),
    rearm,
  }
  void rearm().catch((err) => console.error('[alarm]', err))
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
