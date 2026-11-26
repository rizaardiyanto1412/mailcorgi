import type { EdgeDeps } from './index.ts'
import { parsePostshibaWebhook, parseResendWebhook, parseSesWebhook } from '../email/index.ts'
import { noRedirect, isRedirect } from '../email/http.ts'
import { AppError } from '../core/http.ts'

export async function handleEmailHook(deps: EdgeDeps, request: Request, accountExists: (accountId: string) => Promise<boolean>): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Use POST.', code: 'method_not_allowed' }, { status: 405 })
  const size = Number(request.headers.get('content-length') || 0)
  if (size > 1_048_576) return Response.json({ error: 'Webhook too large.' }, { status: 413 })
  try {
    const body = await request.text()
    if (new TextEncoder().encode(body).length > 1_048_576) return Response.json({ error: 'Webhook too large.' }, { status: 413 })
    const settings = await deps.stores.control.getInstallSettings({ keys: ['ses_sns_topic_arn', 'resend_webhook_secret', 'postshiba_webhook_secret'] })
    const verifiedRequest = new Request(request.url, { method: 'POST', headers: request.headers, body })
    const networkFetch = deps.fetch ?? fetch
    let result: Awaited<ReturnType<typeof parseSesWebhook>>
    try {
      const path = new URL(request.url).pathname
      result = path === '/hooks/ses'
        ? await parseSesWebhook({ platform: { fetch: networkFetch } }, verifiedRequest, settings)
        : path === '/hooks/postshiba'
          ? await parsePostshibaWebhook({ now: deps.now }, verifiedRequest, settings)
          : await parseResendWebhook({ now: deps.now }, verifiedRequest, settings)
    } catch (error) { await deps.stores.control.raiseAlert({ kind: 'webhook_verification', title: 'Email webhook verification failed', body: 'Check the provider signing configuration.' }).catch(() => {}); throw new AppError('invalid_webhook', 'Webhook verification failed.', error instanceof AppError ? error.status : 400) }
    if (result.confirmUrl) {
      const response = await networkFetch(result.confirmUrl, { ...noRedirect, signal: AbortSignal.timeout(10_000) })
      if (isRedirect(response) || !response.ok || response.redirected) throw new Error('Subscription confirmation failed.')
    }
    const groups = new Map<string, typeof result.events>()
    let dropped = 0
    for (const event of result.events) {
      if (!event.accountId) { dropped++; continue }
      const group = groups.get(event.accountId) ?? []
      group.push(event)
      groups.set(event.accountId, group)
    }
    for (const [accountId, events] of groups) {
      if (!(await accountExists(accountId))) { dropped += events.length; continue }
      await deps.stores.account(accountId).ingestProviderEvents({ events })
    }
    return Response.json({ ok: true, dropped })
  } catch (error) {
    return Response.json({ error: 'Webhook could not be processed.', code: 'webhook_failed' }, { status: error instanceof AppError ? error.status : 503 })
  }
}
