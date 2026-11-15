import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'
import { JOURNEY_CONTACTS } from './46-journey-import.ts'

/** Full journey, part 6: the same slice through REST (with idempotency) and MCP, then a read-only key. */
export default async function step({ base, action, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string() }).parse(state.get('journey'))
  const issue = z.object({ id: z.string() }).parse(state.get('issue'))
  const key = await action('apikeys.create', { name: 'Journey API', access: 'full' })
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const rest = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: await r.json().catch(() => null) }
  }
  const page = await rest('GET', `/newsletters/${newsletter.id}/contacts?limit=5`)
  expect(page.status === 200 && page.data.contacts.length === 5 && page.data.nextCursor, 'REST lists contacts with a cursor')
  const created = await rest('POST', `/newsletters/${newsletter.id}/contacts`, { email: 'api-reader@example.com', name: 'API Reader' }, { 'Idempotency-Key': 'journey-contact-1' })
  const replay = await rest('POST', `/newsletters/${newsletter.id}/contacts`, { email: 'api-reader@example.com', name: 'API Reader' }, { 'Idempotency-Key': 'journey-contact-1' })
  expect(created.status < 300 && created.data.outcome === 'subscribed' && replay.status === created.status && replay.data.contact.id === created.data.contact.id, `REST creates once and replays the idempotent result (${created.status}/${replay.status})`)
  const report = await rest('GET', `/campaigns/${issue.id}/report`)
  expect(report.status === 200 && report.data.counts.sent === JOURNEY_CONTACTS / 2, 'REST reads the campaign report')
  const forbidden = await rest('GET', `/campaigns/cmp_doesnotexist0000/report`)
  expect(forbidden.status === 404, 'REST answers 404 for an unknown campaign')
  const mcp = async (id: number, method: string, params: unknown = {}) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    expect(r.ok, `MCP ${method} answered ${r.status}`)
    return r.json()
  }
  await mcp(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'MailCorgi journey', version: '1' } })
  const tools = await mcp(2, 'tools/list')
  const send = tools.result.tools.find((t: { name: string }) => t.name === 'campaigns_send')
  expect(send?.annotations?.destructiveHint === true, 'MCP marks the send tool destructive')
  const count = await mcp(3, 'tools/call', { name: 'segments_count', arguments: { newsletterId: newsletter.id, filter: { field: 'status', in: ['subscribed'] } } })
  // 2,000 imported, less one unsubscribe, one bounce and one complaint, plus the opt-in reader and the REST contact.
  expect(count.result?.isError === false && count.result.structuredContent.count === JOURNEY_CONTACTS - 3 + 2, `MCP counts subscribed contacts (${count.result?.structuredContent?.count})`)
  const stats = await mcp(4, 'tools/call', { name: 'stats_report', arguments: { campaignId: issue.id } })
  expect(stats.result?.structuredContent?.counts?.sent === JOURNEY_CONTACTS / 2, 'MCP reads the report')
  const readOnly = await action('apikeys.create', { name: 'Journey read', access: 'read' })
  const ro = await fetch(`${base}/api/v1/newsletters/${newsletter.id}/contacts`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${readOnly.secret}` }, body: JSON.stringify({ email: 'nope@example.com' }) })
  expect(ro.status === 403, `a read key cannot write (${ro.status})`)
  await action('apikeys.revoke', { keyId: key.id })
  await action('apikeys.revoke', { keyId: readOnly.id })
}
