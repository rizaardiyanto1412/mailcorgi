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

export function createSmokeContext(base: string) {
  const jar = new Jar()
  const json = async (method: string, p: string, body?: unknown, status = 200) => {
    const r = await call(base, jar, method, p, body)
    const data = await r.json().catch(() => null)
    expect(r.status === status, `${method} ${p} answered ${r.status}: ${JSON.stringify(data)}`)
    return data
  }
  return { base, jar, json, call: (method: string, p: string, body?: unknown) => call(base, jar, method, p, body), expect, state: new Map<string, unknown>() }
}

export type SmokeContext = ReturnType<typeof createSmokeContext>
