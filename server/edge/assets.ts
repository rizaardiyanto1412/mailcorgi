/**
 * Static web app rules shared by both platforms. Client-side routes get the SPA shell; a missing
 * file, and anything under /assets/, is a real 404. An old tab that asks for a hashed chunk from the
 * previous build must see a 404, not index.html served as JavaScript.
 */
export function isSpaRoute(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return false
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return !last.includes('.')
}

/** Wrap an asset fetcher that answers 404 on a miss (Workers `not_found_handling: "none"`) with the SPA fallback. */
export function withSpaFallback(fetchAsset: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await fetchAsset(request)
    if (response.status !== 404) return response
    const method = request.method.toUpperCase()
    if ((method !== 'GET' && method !== 'HEAD') || !isSpaRoute(new URL(request.url).pathname)) return response
    return fetchAsset(new Request(new URL('/', request.url), { method, headers: request.headers }))
  }
}

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$|\.localhost$/i

/**
 * HSTS only when the app is served over https on a real host. The app URL wins when set; otherwise
 * the scheme the request arrived on (a trusted proxy's `x-forwarded-proto` on Node). Browsers ignore
 * the header on plain http responses, so the request scheme cannot pin a host by mistake.
 */
export function wantsHsts(appUrl: string, requestUrl: URL, forwardedProto: string | null): boolean {
  let origin: URL
  try {
    origin = new URL(appUrl || requestUrl.href)
  } catch {
    return false
  }
  const https = appUrl ? origin.protocol === 'https:' : requestUrl.protocol === 'https:' || forwardedProto?.split(',')[0].trim().toLowerCase() === 'https'
  return https && !LOCAL_HOST.test(origin.hostname)
}

export const HSTS_VALUE = 'max-age=31536000'
