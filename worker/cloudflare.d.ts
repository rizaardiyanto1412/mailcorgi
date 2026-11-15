// Minimal types for the Workers runtime pieces this project uses.
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}

interface SqlCursor {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
}
interface DurableObjectState {
  id: { toString(): string }
  /** Stop this object now. The next request starts a fresh one with the latest code. Always throws. */
  abort(reason?: string): never
  waitUntil(p: Promise<unknown>): void
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor }
    kv: { get<T = unknown>(key: string): T | undefined; put(key: string, value: unknown): void }
    transactionSync<T>(fn: () => T): T
    getAlarm(): Promise<number | null>
    setAlarm(time: number): Promise<void>
    deleteAlarm(): Promise<void>
    /** Removes every key and SQL table of a SQLite-backed object. */
    deleteAll(): Promise<void>
  }
}
interface DurableObjectId {
  toString(): string
}
type DurableObjectStub<T> = { fetch(request: Request): Promise<Response> } & { [K in keyof T as T[K] extends (...args: any[]) => any ? K : never]: T[K] }
interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub<T>
}
interface Fetcher {
  fetch(request: Request): Promise<Response>
}
interface R2Bucket {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void
}
