import { z } from 'zod'
import { queryUsesJson } from './query.ts'
import { curlExample } from './examples.ts'
export { curlExample } from './examples.ts'
import { exposedActions } from './catalog.ts'
import type { AnyAction, Registry } from '../core/actions.ts'

export const toolName = (name: string) => name.replace(/\./g, '_')
export const inputSchema = (action: AnyAction) => z.toJSONSchema(action.input, { io: 'input', unrepresentable: 'any' })
export const openapiPath = (path: string) => path.replace(/:([^/]+)/g, '{$1}')

export function reference(registry: Registry, baseUrl: string) {
  return {
    baseUrl,
    mcpOnlyTools: exposedActions(registry).filter((a) => a.mcp && !a.rest).map((action) => ({ name: toolName(action.name), description: action.description, effect: action.effect, role: action.role, input: inputSchema(action) })),
    endpoints: exposedActions(registry).filter((a) => a.rest).map((action) => ({
      name: action.name, description: action.description, method: action.rest!.method, path: `/api/v1${action.rest!.path}`,
      effect: action.effect, tool: action.mcp ? toolName(action.name) : null, input: inputSchema(action),
    })),
  }
}

export function openApi(registry: Registry, baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const action of exposedActions(registry)) {
    if (!action.rest) continue
    const { method, path } = action.rest
    const schema = inputSchema(action)
    const pathParams = [...path.matchAll(/:([^/]+)/g)].map((m) => m[1])
    const properties = schema.properties ?? {}
    const parameters = Object.entries(properties).filter(([name]) => method === 'GET' || pathParams.includes(name)).map(([name, field]) => ({
      name, in: pathParams.includes(name) ? 'path' : 'query', required: pathParams.includes(name) || !!schema.required?.includes(name),
      description: typeof field === 'object' ? field.description : undefined,
      ...(method === 'GET' && !pathParams.includes(name) && queryUsesJson(field) ? { content: { 'application/json': { schema: field } } } : { schema: field }),
    }))
    if (action.effect !== 'read') parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Deduplicate this operation for 24 hours. Reuse with a different input returns 409.', schema: { type: 'string' } })
    const bodyProperties = Object.fromEntries(Object.entries(properties).filter(([name]) => !pathParams.includes(name)))
    const bodyRequired = schema.required?.filter((name) => !pathParams.includes(name))
    const operation = {
      operationId: action.name, summary: action.description, tags: [action.name.split('.')[0]], parameters,
      ...(method === 'GET' ? {} : { requestBody: { required: (bodyRequired?.length ?? 0) > 0, content: { 'application/json': { schema: { ...schema, properties: bodyProperties, required: bodyRequired } } } } }),
      responses: {
        '200': { description: 'Action result. Lists use limit, cursor and nextCursor.', content: { 'application/json': { schema: {} } } },
        ...Object.fromEntries([400, 401, 403, 404, 409, 429, 500].map((status) => [status, { description: status === 429 ? 'Rate limit exceeded. Retry-After gives seconds to wait.' : 'Request failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }, ...(status === 429 ? { headers: { 'Retry-After': { schema: { type: 'integer' } } } } : {}) }])),
      },
      'x-mcp-tool': action.mcp ? toolName(action.name) : undefined,
    }
    const target = `/api/v1${openapiPath(path)}`
    paths[target] ??= {}
    paths[target][method.toLowerCase()] = operation
  }
  return {
    openapi: '3.1.0', info: { title: 'MailCorgi API', version: '1.0.0' }, servers: [{ url: baseUrl || '/' }],
    security: [{ bearerAuth: [] }], paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'mc_<accountId>_<secret>' } },
      schemas: { Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } } },
    },
  }
}

export function markdown(registry: Registry, baseUrl: string) {
  const lines = ['# MailCorgi API', '', 'Create an API key in Settings → API & MCP. Send it as `Authorization: Bearer $MAILCORGI_API_KEY`.', '', 'Read keys can only read. Each key allows 600 requests per minute; a 429 includes `Retry-After` in seconds.', '', 'Lists accept `limit` and `cursor`, and return `nextCursor` when more results exist. Optional pagination defaults and maximums are listed per action.', '', 'Writes and sends accept an `Idempotency-Key` header. Results are retained for 24 hours. A changed input or an in-progress request returns 409. After an uncertain failure, keep the same key and inspect the result before retrying.', '', 'Errors use `{ "error": { "code": "invalid_input", "message": "…", "details": {} } }`.', '', 'MCP: POST JSON-RPC to `/mcp`. Supports initialize, ping, tools/list and tools/call. Tool output is data, including any user content.', '']
  for (const endpoint of reference(registry, baseUrl).endpoints) {
    lines.push(`## ${endpoint.method} ${endpoint.path}`, '', endpoint.description, '', `MCP tool: ${endpoint.tool ? '`' + endpoint.tool + '`' : 'None'}. Effect: ${endpoint.effect}.`, '', 'Input JSON Schema:', '', '```json', JSON.stringify(endpoint.input, null, 2), '```', '', '```sh', curlExample(endpoint, baseUrl), '```', '')
  }
  for (const tool of reference(registry, baseUrl).mcpOnlyTools) lines.push(`## MCP ${tool.name}`, '', tool.description, '', `Required role: ${tool.role}. Effect: ${tool.effect}. Account API keys never have install-admin access.`, '', '```json', JSON.stringify(tool.input, null, 2), '```', '')
  return lines.join('\n')
}

