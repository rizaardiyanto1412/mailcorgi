/**
 * A throwaway install for tests: control store and account stores on a temp directory, a fake
 * clock, a fake DNS resolver, the test email provider, and helpers to sign up and act as a user.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig, type Config } from '../core/config.ts'
import type { DnsType } from '../core/platform.ts'
import { createNodeApp, type NodeApp } from '../platform-node.ts'
import type { SessionInfo } from '../control/rpc.ts'
import type { ActionInput, ActionName, ActionOutput } from '../registry.ts'
import type { OutboxRow } from '../email/test.ts'
import type { ErrorBody } from '../core/http.ts'

export const APP_URL = 'http://app.example.com'

export interface Clock {
  now(): number
  advance(ms: number): void
  set(ms: number): void
}

export interface Client {
  email: string
  cookie: string
  csrf: string
  session: SessionInfo
  accountId: string | null
  fetch(path: string, init?: RequestInit & { csrf?: boolean }): Promise<Response>
  get<T = any>(path: string): Promise<T>
  post<T = any>(path: string, body?: unknown): Promise<T>
  /** Call an action and return its output. Throws an `ActionError` on a non-2xx answer. */
  action<K extends ActionName>(name: K, input: ActionInput<K>): Promise<ActionOutput<K>>
  actionRaw(name: string, input: unknown): Promise<Response>
  refresh(): Promise<void>
}

export class ActionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export interface Install {
  app: NodeApp
  config: Config
  clock: Clock
  dataDir: string
  /** `fail(true)` makes every lookup throw, as a resolver outage does. */
  dns: { set(name: string, type: DnsType, values: string[]): void; fail(on: boolean): void }
  /** `refuseWrites(true)` makes every row write and alarm fail as Cloudflare's daily quota does. */
  refuseWrites(on: boolean): void
  /** Rows written by every open store since the install opened (alarms included). */
  writes(): number
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Emails the test provider wrote: in the control store, or in one account store. */
  outbox(scope?: 'control' | string): OutboxRow[]
  /** The newest 6-digit code emailed to an address. */
  lastCode(email: string): string
  /** First visitor on self-hosted (setup), or a sign-up in either mode. */
  signUp(input: { email: string; name?: string; password?: string }): Promise<Client>
  signIn(email: string, password: string): Promise<Client>
  clientFromCookie(cookie: string): Promise<Client>
  /** Run every due alarm, repeatedly, until nothing is due. */
  runJobs(): Promise<void>
  tick(): Promise<void>
  /** Close everything and open the same data directory again, as a process restart would. */
  restart(): Promise<Install>
  close(): void
}

export function fakeClock(start = Date.UTC(2026, 0, 15, 12, 0, 0)): Clock {
  let at = start
  return { now: () => at, advance: (ms) => void (at += ms), set: (ms) => void (at = ms) }
}

export interface InstallOptions {
  cloud?: boolean
  env?: Record<string, string>
  dataDir?: string
  clock?: Clock
}

export async function createInstall(opts: InstallOptions = {}): Promise<Install> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mailcorgi-test-'))
  const clock = opts.clock ?? fakeClock()
  const config = parseConfig({ DATA_DIR: dataDir, APP_URL: APP_URL, CLOUD: opts.cloud ? 'true' : '', ...opts.env })
  const dns = new Map<string, string[]>()
  let dnsDown = false
  let writesRefused = false
  const app = await createNodeApp({
    config,
    now: clock.now,
    refuseWrites: () => writesRefused,
    fetch: async () => {
      throw new Error('Tests must not reach the network.')
    },
    resolveDns: async (name, type) => {
      if (dnsDown) throw new Error('DNS resolver unreachable')
      return dns.get(`${type}:${name.toLowerCase()}`) ?? []
    },
    log: () => {},
  })

  const fetchEdge = (p: string, init?: RequestInit) => app.edge.fetch(new Request(p.startsWith('http') ? p : APP_URL + p, init))

  const cookieJar = (headers: Headers, jar: Record<string, string>) => {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const gone = attrs.some((a) => /max-age=0/i.test(a.trim()))
      if (gone || value === '') delete jar[name]
      else jar[name] = value
    }
  }
  const cookieHeader = (jar: Record<string, string>) =>
    Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')

  async function clientFromJar(jar: Record<string, string>, email: string): Promise<Client> {
    const client: Client = {
      email,
      cookie: cookieHeader(jar),
      csrf: '',
      session: null as unknown as SessionInfo,
      accountId: null,
      async fetch(p, init = {}) {
        const headers = new Headers(init.headers)
        headers.set('cookie', cookieHeader(jar))
        if (init.csrf !== false && init.method && init.method !== 'GET') headers.set('x-mc-csrf', client.csrf)
        if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
        const response = await fetchEdge(p, { ...init, headers })
        cookieJar(response.headers, jar)
        client.cookie = cookieHeader(jar)
        return response
      },
      async get(p) {
        const response = await client.fetch(p)
        const data = await response.json()
        if (!response.ok) throw new ActionError(response.status, (data as ErrorBody).code, (data as ErrorBody).error, (data as ErrorBody).details)
        return data
      },
      async post(p, body = {}) {
        const response = await client.fetch(p, { method: 'POST', body: JSON.stringify(body) })
        const data = await response.json()
        if (!response.ok) throw new ActionError(response.status, (data as ErrorBody).code, (data as ErrorBody).error, (data as ErrorBody).details)
        return data
      },
      actionRaw: (name, input) => client.fetch(`/api/actions/${name}`, { method: 'POST', body: JSON.stringify(input ?? {}) }),
      async action(name, input) {
        const response = await client.actionRaw(name, input)
        const data = await response.json()
        if (!response.ok) throw new ActionError(response.status, (data as ErrorBody).code, (data as ErrorBody).error, (data as ErrorBody).details)
        return data
      },
      async refresh() {
        const boot = await client.get<{ session: SessionInfo | null }>('/api/auth/bootstrap')
        if (!boot.session) throw new Error('Not signed in.')
        client.session = boot.session
        client.csrf = boot.session.csrf
        client.accountId = boot.session.current
      },
    }
    await client.refresh()
    return client
  }

  const postJson = async (p: string, body: unknown, jar: Record<string, string>) => {
    const response = await fetchEdge(p, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(jar) }, body: JSON.stringify(body) })
    cookieJar(response.headers, jar)
    const data = await response.json()
    if (!response.ok) throw new ActionError(response.status, (data as ErrorBody).code, (data as ErrorBody).error, (data as ErrorBody).details)
    return data as any
  }

  const install: Install = {
    app,
    config,
    clock,
    dataDir,
    dns: { set: (name, type, values) => void dns.set(`${type}:${name.toLowerCase()}`, values), fail: (on) => void (dnsDown = on) },
    refuseWrites: (on) => void (writesRefused = on),
    writes: () => [app.control, ...app.accountIds().map((id) => app.account(id))].reduce((n, store) => n + store.meter.writes, 0),
    fetch: fetchEdge,
    outbox(scope = 'control') {
      const store = scope === 'control' ? app.control : app.account(scope)
      return store.ctx.db.all<OutboxRow>('SELECT * FROM outbox ORDER BY rowid')
    },
    lastCode(email) {
      const rows = install.outbox('control').filter((r) => r.to_email === email.toLowerCase())
      const last = rows[rows.length - 1]
      const match = last && /\b(\d{6})\b/.exec(last.text)
      if (!match) throw new Error(`No code was emailed to ${email}.`)
      return match[1]
    },
    async signUp({ email, name = 'Test User', password = 'correct horse battery' }) {
      const jar: Record<string, string> = {}
      const boot = await (await fetchEdge('/api/auth/bootstrap')).json()
      if (boot.setupRequired) await postJson('/api/auth/setup', { email, name, password }, jar)
      else {
        const result = await postJson('/api/auth/signup', { email, name, password }, jar)
        if (result.pending) await postJson('/api/auth/signup/verify', { email, code: install.lastCode(email) }, jar)
      }
      return clientFromJar(jar, email)
    },
    async signIn(email, password) {
      const jar: Record<string, string> = {}
      await postJson('/api/auth/signin', { email, password }, jar)
      return clientFromJar(jar, email)
    },
    clientFromCookie: (cookie) => clientFromJar(Object.fromEntries(cookie.split(';').map((p) => p.trim().split('=') as [string, string])), ''),
    tick: () => app.tick(),
    async runJobs() {
      for (let i = 0; i < 20; i++) {
        const due = [app.control, ...app.accountIds().map((id) => app.account(id))].some((s) => (s.nextWakeAt() ?? Infinity) <= clock.now())
        if (!due) return
        await app.tick()
      }
    },
    async restart() {
      app.close()
      return createInstall({ ...opts, dataDir, clock })
    },
    close() {
      app.close()
      if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return install
}

/** Run `fn` and return the ActionError it throws. Fails the test when nothing is thrown. */
export async function expectError(fn: () => Promise<unknown>): Promise<ActionError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ActionError) return err
    throw err
  }
  throw new Error('Expected the call to fail.')
}
