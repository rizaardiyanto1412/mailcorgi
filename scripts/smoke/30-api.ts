import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ base, json, call, expect, state }: SmokeContext) {
  const created = state.get('newsletter')
  if (!created || typeof created !== 'object' || !('id' in created)) throw new Error('smoke: newsletter step must run first')
  const key = await json('POST', '/api/actions/apikeys.create', { name: 'Smoke API', access: 'full' })
  const apiHeaders = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const api = await fetch(`${base}/api/v1/newsletters`, { headers: apiHeaders })
  expect(api.ok && (await api.json()).newsletters[0].id === created.id, 'API key reads newsletters')
  const mcp = async (id: number, method: string, params: unknown = {}) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: apiHeaders, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    expect(response.ok, `MCP ${method} answered ${response.status}`)
    return response.json()
  }
  const initialized = await mcp(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'MailCorgi smoke', version: '1' } })
  expect(initialized.result?.protocolVersion === '2025-06-18', 'MCP initializes')
  const tools = await mcp(2, 'tools/list')
  expect(tools.result?.tools.some((tool: { name: string }) => tool.name === 'newsletters_list'), 'MCP lists registry tools')
  const tool = await mcp(3, 'tools/call', { name: 'newsletters_list', arguments: {} })
  expect(tool.result?.isError === false && tool.result.structuredContent.newsletters[0].id === created.id, 'MCP calls a tool')
  const docs = await json('POST', '/api/actions/api.reference', {})
  expect(docs.endpoints.some((endpoint: { name: string }) => endpoint.name === 'newsletters.list'), 'API reference reads the registry')
  const keys = await json('POST', '/api/actions/apikeys.list', {})
  expect(keys.keys.some((item: { id: string }) => item.id === key.id), 'API settings lists the created key')
  for (const page of ['/settings/api', '/docs/api']) {
    const response = await call('GET', page)
    expect(response.ok && (await response.text()).includes('id="root"'), `${page} serves the SPA`)
  }
  const llms = await fetch(`${base}/llms.txt`)
  expect(llms.ok && (await llms.text()).includes('newsletters_list'), 'llms.txt serves the generated reference')
  await json('POST', '/api/actions/apikeys.revoke', { keyId: key.id })
  expect((await fetch(`${base}/api/v1/newsletters`, { headers: apiHeaders })).status === 401, 'revoked API keys are refused')
}
