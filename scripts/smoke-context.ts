/**
 * Canned DNS answers for the full journey (`MC_TEST_DNS`). Both runners pass them to the server
 * under test; production never sets the flag.
 */
export const SMOKE_DNS = {
  'TXT:smoke.example.com': ['v=spf1 mx ~all'],
  'TXT:_dmarc.smoke.example.com': ['v=DMARC1; p=none'],
  'MX:smoke.example.com': ['mx.smoke.example.com'],
  'MX:example.com': ['mx.example.com'],
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `probe` until it returns a value, for at most `ms`. */
export async function waitUntil<T>(label: string, ms: number, probe: () => Promise<T | null | undefined | false>, every = 250): Promise<T> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const value = await probe()
    if (value) return value
    await sleep(every)
  }
  throw new Error(`smoke: ${label} did not happen within ${ms} ms`)
}

export class Jar {
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

export async function call(base: string, jar: Jar, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: jar.header() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (jar.csrf && method !== 'GET') headers['x-mc-csrf'] = jar.csrf
  const response = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
  jar.absorb(response)
  return response
}

export const expect = (ok: unknown, message: string) => {
  if (!ok) throw new Error(`smoke: ${message}`)
}

export function createSmokeContext(base: string, mode: 'selfhosted' | 'cloud' = 'selfhosted') {
  const jar = new Jar()
  const json = async (method: string, p: string, body?: unknown, status = 200) => {
    const r = await call(base, jar, method, p, body)
    const data = await r.json().catch(() => null)
    expect(r.status === status, `${method} ${p} answered ${r.status}: ${JSON.stringify(data)}`)
    return data
  }
  /** Call an action as the signed-in user; `status` is the expected HTTP status. */
  const action = (name: string, input: unknown = {}, status = 200) => json('POST', `/api/actions/${name}`, input, status)
  return { base, mode, jar, json, action, call: (method: string, p: string, body?: unknown) => call(base, jar, method, p, body), expect, state: new Map<string, unknown>() }
}

export type SmokeContext = ReturnType<typeof createSmokeContext>
