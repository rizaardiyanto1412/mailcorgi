import { AppError } from './http.ts'

/** What a store may do outside its own database. Each platform provides one. */
export type StoreRef = { kind: 'control' } | { kind: 'account'; accountId: string }

export const storeId = (ref: StoreRef) => (ref.kind === 'control' ? 'control' : ref.accountId)

export interface Blob {
  bytes: Uint8Array
  contentType: string
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Blob | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

export type DnsType = 'TXT' | 'CNAME' | 'MX' | 'A'

export interface Platform {
  blobs: BlobStore
  fetch: typeof fetch
  /** Wake the store at `at` (ms). The earliest requested time wins. */
  setAlarm(store: StoreRef, at: number | null): Promise<void>
  resolveDns(name: string, type: DnsType): Promise<string[]>
  waitUntil(p: Promise<unknown>): void
  limits: { subrequestsPerRun: number }
  /** Remove a store's database and alarm for good. Only the control store calls it, for an account whose data is wiped. */
  destroyStore(store: StoreRef): Promise<void>
}

/** Answers from `MC_TEST_DNS` when the flag is on (never in production), else the real resolver. */
export function dnsResolver(testDns: Record<string, string[]> | null, real: Platform['resolveDns']): Platform['resolveDns'] {
  if (!testDns) return real
  return async (name, type) => testDns[`${type}:${name.toLowerCase().replace(/\.$/, '')}`] ?? []
}

/** Thrown when the resolver could not answer. It never means "no records". */
export class DnsUnavailableError extends Error {
  constructor(message = 'DNS lookup failed') {
    super(message)
    this.name = 'DnsUnavailableError'
  }
}

/**
 * Turns any resolver failure into the user-facing "try again" error. Callers must change no state
 * when this throws: a resolver outage says nothing about the records.
 */
export async function lookupDns(platform: Pick<Platform, 'resolveDns'>, name: string, type: DnsType): Promise<string[]> {
  try {
    return await platform.resolveDns(name, type)
  } catch {
    throw new AppError('dns_unavailable', 'We could not check DNS right now. Nothing was changed. Try again in a few minutes.', 503)
  }
}

/** DNS over HTTPS through Cloudflare's resolver. Tests swap in a fake. */
export async function resolveDnsOverHttps(fetchFn: typeof fetch, name: string, type: DnsType): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`
  let response: Response
  try {
    response = await fetchFn(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new DnsUnavailableError()
  }
  if (!response.ok) throw new DnsUnavailableError(`DNS resolver answered ${response.status}`)
  let data: { Status?: number; Answer?: { type: number; data: string }[] }
  try {
    data = (await response.json()) as typeof data
  } catch {
    throw new DnsUnavailableError('DNS resolver sent an unreadable answer')
  }
  // 0 NOERROR and 3 NXDOMAIN are real answers; anything else (SERVFAIL, REFUSED, …) is not.
  if (data.Status !== undefined && data.Status !== 0 && data.Status !== 3) throw new DnsUnavailableError(`DNS resolver status ${data.Status}`)
  const wanted = { A: 1, CNAME: 5, MX: 15, TXT: 16 }[type]
  return (data.Answer ?? []).filter((a) => a.type === wanted).map((a) => (type === 'TXT' ? a.data.replace(/^"|"$/g, '').replace(/"\s+"/g, '') : a.data.replace(/\.$/, '')))
}

/** Blob store that keeps everything in memory. Used by tests and as a fallback. */
export function memoryBlobs(): BlobStore {
  const map = new Map<string, Blob>()
  return {
    put: async (key, bytes, contentType) => void map.set(key, { bytes, contentType }),
    get: async (key) => map.get(key) ?? null,
    delete: async (key) => void map.delete(key),
    list: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  }
}
