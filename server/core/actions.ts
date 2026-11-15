import { validateMigrations, type Migration } from './db.ts'
import type { z } from 'zod'
import type { Hono } from 'hono'
import type { StoreCtx } from './store.ts'
import type { JobHandler } from './jobs.ts'
import { AppError, forbidden, notFound, type StoreEnv } from './http.ts'

export type Scope = 'account' | 'control'
export type AccountRole = 'member' | 'admin' | 'owner'
export type ControlRole = 'user' | 'installAdmin'
export type Effect = 'read' | 'write' | 'send'
export type ResourceType = 'newsletter' | 'contact' | 'segment' | 'campaign' | 'import' | 'author' | 'tag' | 'domain' | 'apiKey' | 'account'
export type RestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

const NEWSLETTER_SCOPED = new Set<ResourceType>(['newsletter', 'contact', 'segment', 'campaign', 'import', 'author', 'tag'])
const RANK: Record<AccountRole, number> = { member: 1, admin: 2, owner: 3 }

/** Who is acting. Built by the edge from a session, or by the account store from an API key. */
export interface Actor {
  userId: string
  email: string
  owner: boolean
  grants: Record<string, 'admin' | 'member'>
  access: 'full' | 'read'
  via: 'web' | 'api' | 'mcp'
  keyId?: string
  installAdmin: boolean
}

export interface ActionDef<S extends Scope = Scope, N extends string = string, I extends z.ZodType = z.ZodType, O = unknown> {
  name: N
  description: string
  scope: S
  role: S extends 'account' ? AccountRole : ControlRole
  effect: Effect
  resource?: { type: ResourceType; param: string }
  input: I
  rest?: { method: RestMethod; path: string }
  mcp?: { title: string; destructive: boolean }
  handler: (ctx: StoreCtx, input: z.output<I>, actor: Actor) => Promise<O> | O
}

export function defineAction<S extends Scope, N extends string, I extends z.ZodType, O>(def: ActionDef<S, N, I, O>): ActionDef<S, N, I, O> {
  return def
}

export type AnyAction = ActionDef<Scope, string, z.ZodType, any>

/** A map from action name to its definition, derived from a tuple of definitions. */
export type ActionsOf<T extends readonly AnyAction[]> = { [D in T[number] as D['name']]: D }
export type InputOf<A> = A extends { input: infer I extends z.ZodType } ? z.input<I> : never
export type OutputOf<A> = A extends { handler: (...args: any[]) => infer R } ? Awaited<R> : never

export type Resolver = (ctx: StoreCtx, id: string) => string | null
export type RpcFn = (ctx: StoreCtx, args: any) => unknown
export type RouteMount = (app: Hono<StoreEnv>) => void
export type Maintenance = (ctx: StoreCtx) => void

export interface Registry {
  scope: Scope
  actions: Map<string, AnyAction>
  jobs: Map<string, JobHandler>
  rpc: Map<string, RpcFn>
  routes: RouteMount[]
  resolvers: Map<ResourceType, Resolver>
  migrations: Migration[]
  maintenance: Maintenance[]
  /** Runs before every handler. The account store uses it to refuse sends while blocked. */
  guard?: (ctx: StoreCtx, action: AnyAction, actor: Actor) => void
}

type RpcShape = Record<string, (args: any) => Promise<any>>

/** What a module's `register(reg)` receives. `R` is the store's RPC interface. */
export interface Registrar<S extends Scope, R extends RpcShape> {
  readonly scope: S
  /** Typed `unknown[]` on purpose: a tighter constraint widens each action's literal name. Scope is checked at registration. */
  actions<T extends readonly unknown[]>(...defs: T): T
  job<P = any>(kind: string, handler: JobHandler<P>): void
  rpc<K extends keyof R & string>(name: K, fn: (ctx: StoreCtx, args: Parameters<R[K]>[0]) => Awaited<ReturnType<R[K]>> | Promise<Awaited<ReturnType<R[K]>>>): void
  routes(mount: RouteMount): void
  resolver(type: ResourceType, fn: Resolver): void
  migrations(migrations: readonly Migration[]): void
  maintenance(fn: Maintenance): void
}

export interface Module<S extends Scope, R extends RpcShape> {
  name: string
  register(reg: Registrar<S, R>): readonly AnyAction[] | void
}

export function buildRegistry<S extends Scope, R extends RpcShape>(scope: S, modules: Module<S, R>[], guard?: Registry['guard']): Registry {
  const registry: Registry = { scope, actions: new Map(), jobs: new Map(), rpc: new Map(), routes: [], resolvers: new Map(), maintenance: [], migrations: [], guard }
  const reg: Omit<Registrar<S, R>, 'migrations'> = {
    scope,
    actions: (...defs) => {
      for (const def of defs as readonly AnyAction[]) {
        if (registry.actions.has(def.name)) throw new Error(`Action ${def.name} is registered twice.`)
        if (def.scope !== scope) throw new Error(`Action ${def.name} has scope ${def.scope} but is registered on the ${scope} store.`)
        registry.actions.set(def.name, def)
      }
      return defs
    },
    job: (kind, handler) => {
      if (registry.jobs.has(kind)) throw new Error(`Job ${kind} is registered twice.`)
      registry.jobs.set(kind, handler)
    },
    rpc: (name, fn) => {
      if (registry.rpc.has(name)) throw new Error(`RPC ${name} is registered twice.`)
      registry.rpc.set(name, fn as RpcFn)
    },
    routes: (mount) => void registry.routes.push(mount),
    resolver: (type, fn) => {
      if (registry.resolvers.has(type)) throw new Error(`Resolver for ${type} is registered twice.`)
      registry.resolvers.set(type, fn)
    },
    maintenance: (fn) => void registry.maintenance.push(fn),
  }
  for (const m of modules) {
    m.register({
      ...reg,
      migrations: (migrations) => {
        validateMigrations(migrations)
        for (const migration of migrations) {
          const prefix = migration.id.slice(0, 11)
          if (!/^\d{4}-\d{2}-\d{2}-$/.test(prefix) || !migration.id.startsWith(`${prefix}${m.name}-`)) throw new Error(`Malformed migration id for module ${m.name}: ${migration.id}`)
        }
        registry.migrations.push(...migrations)
        validateMigrations(registry.migrations)
      },
    })
  }
  return registry
}

/** Which newsletter a resource belongs to. Each module registers the resolver for its own type. */
export function resolveNewsletterId(ctx: StoreCtx, type: ResourceType, id: string): string {
  const resolver = ctx.registry.resolvers.get(type)
  if (!resolver) throw new Error(`No resolver registered for resource type ${type}.`)
  const newsletterId = resolver(ctx, id)
  if (!newsletterId) throw notFound()
  return newsletterId
}

export function meetsRole(actor: Actor, newsletterId: string, role: AccountRole): boolean {
  if (actor.owner) return true
  const grant = actor.grants[newsletterId]
  return !!grant && RANK[grant] >= RANK[role]
}

function authorize(ctx: StoreCtx, action: AnyAction, input: Record<string, unknown>, actor: Actor) {
  if (actor.access === 'read' && action.effect !== 'read') throw forbidden('This API key is read-only.')
  if (action.scope === 'control') {
    if (action.role === 'installAdmin' && !actor.installAdmin) throw forbidden('Only an install admin can do that.')
    return
  }
  const role = action.role as AccountRole
  const resource = action.resource
  if (!resource) {
    if (actor.owner) return
    if (role === 'owner' || !Object.values(actor.grants).some((g) => RANK[g] >= RANK[role])) throw forbidden()
    return
  }
  const id = input[resource.param]
  if (typeof id !== 'string' || !id) throw new AppError('invalid_input', `${resource.param} is required.`, 400)
  if (NEWSLETTER_SCOPED.has(resource.type)) {
    const newsletterId = resolveNewsletterId(ctx, resource.type, id)
    if (typeof input.newsletterId === 'string' && input.newsletterId !== newsletterId) throw notFound()
    if (!meetsRole(actor, newsletterId, role)) throw forbidden()
    return
  }
  if (!actor.owner) throw forbidden('Only the account owner can do that.')
}

/** The only way to run an action: validates, authorizes, then calls the handler. */
export async function runAction(ctx: StoreCtx, name: string, rawInput: unknown, actor: Actor): Promise<unknown> {
  const action = ctx.registry.actions.get(name)
  if (!action) throw new AppError('unknown_action', `Unknown action ${name}.`, 404)
  const parsed = action.input.safeParse(rawInput ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
    const first = issues[0]
    throw new AppError('invalid_input', first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Invalid input.', 400, { issues })
  }
  const input = parsed.data as Record<string, unknown>
  authorize(ctx, action, input, actor)
  ctx.registry.guard?.(ctx, action, actor)
  try {
    return await action.handler(ctx, input, actor)
  } catch (err) {
    if (ctx.config.cloud && err instanceof AppError && err.code === 'limit_reached') throw new AppError(err.code, err.message, err.status, { billingUrl: '/settings/billing' })
    throw err
  }
}

/** A typed `runAction` for a known action map, used by tests and the web client types. */
export type Runner<M extends Record<string, AnyAction>> = <K extends keyof M & string>(name: K, input: InputOf<M[K]>) => Promise<OutputOf<M[K]>>
