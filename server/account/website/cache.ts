export interface CachedPage { body: string; type: string; etag: string; csp: string; campaignId: string | null; status?: number; expiresAt?: number }
interface CacheApi { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> }
const pages = new Map<string, CachedPage>()
let bytes = 0
const LIMIT = 8_000_000
function isCacheApi(value: unknown): value is CacheApi {
  return value !== null && typeof value === 'object' && 'match' in value && typeof value.match === 'function' && 'put' in value && typeof value.put === 'function'
}
function cloudCache(): CacheApi | undefined {
  if ('caches' in globalThis) {
    const cache: unknown = globalThis.caches
    if (cache && typeof cache === 'object' && 'default' in cache && isCacheApi(cache.default)) return cache.default
  }
}
export async function readPage(key: string, cloud: boolean, now: number): Promise<CachedPage | undefined> {
  if (cloud) {
    const response = await cloudCache()?.match(new Request(key))
    if (response) return { body: await response.text(), type: response.headers.get('content-type') || 'text/html', etag: response.headers.get('etag') || '', csp: response.headers.get('content-security-policy') || '', campaignId: response.headers.get('x-website-campaign') || null, status: Number(response.headers.get('x-website-status')) || 200 }
    return
  }
  const page = pages.get(key)
  if (page && page.expiresAt !== undefined && page.expiresAt <= now) {
    bytes -= page.body.length
    pages.delete(key)
    return
  }
  if (page) { pages.delete(key); pages.set(key, page) }
  return page
}
export async function writePage(key: string, page: CachedPage, cloud: boolean): Promise<void> {
  if (cloud) {
    await cloudCache()?.put(new Request(key), new Response(page.body, { headers: { 'content-type': page.type, etag: page.etag, 'content-security-policy': page.csp, 'cache-control': `public, max-age=${page.status === 404 ? 60 : 300}`, 'x-website-campaign': page.campaignId ?? '', 'x-website-status': String(page.status ?? 200) } }))
    return
  }
  if (page.body.length > LIMIT / 2) return
  const old = pages.get(key)
  if (old) bytes -= old.body.length
  pages.delete(key)
  pages.set(key, page)
  bytes += page.body.length
  while (bytes > LIMIT || pages.size > 256) {
    const first = pages.keys().next().value
    if (!first) break
    bytes -= pages.get(first)!.body.length
    pages.delete(first)
  }
}
