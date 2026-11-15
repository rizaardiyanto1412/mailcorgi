import type { z } from 'zod'
import type { reference } from './reference.ts'

function exampleValue(schema: z.core.JSONSchema.JSONSchema | boolean): unknown {
  if (typeof schema === 'boolean') return null
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (schema.enum?.length) return schema.enum[0]
  if (schema.anyOf?.length) return exampleValue(schema.anyOf[0])
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([name]) => schema.required?.includes(name)).map(([name, field]) => [name, exampleValue(field)]))
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 1
  return schema.format === 'email' ? 'reader@example.com' : 'example'
}

export function curlExample(endpoint: ReturnType<typeof reference>['endpoints'][number], baseUrl: string) {
  const fields = Object.entries(endpoint.input.properties ?? {}).filter(([name]) => !endpoint.path.includes(`:${name}`))
  const body = Object.fromEntries(fields.filter(([name, schema]) => endpoint.input.required?.includes(name) || (typeof schema === 'object' && schema.default !== undefined)).map(([name, schema]) => [name, exampleValue(schema)]))
  const query = new URLSearchParams(Object.entries(body).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]))
  const url = `${baseUrl || 'https://mail.example.com'}${endpoint.path.replace(/:([^/]+)/g, (_match, name: string) => `YOUR_${name.replace(/([A-Z])/g, '_$1').toUpperCase()}`)}${endpoint.method === 'GET' && query.size ? '?' + query : ''}`
  const lines = [`curl -X ${endpoint.method} '${url}'`, '  -H "Authorization: Bearer $MAILCORGI_API_KEY"']
  if (endpoint.method !== 'GET') lines.push('  -H "Content-Type: application/json"', '  -H "Idempotency-Key: unique-request-id"', `  --data '${JSON.stringify(body).replace(/'/g, "'\\''")}'`)
  return lines.join(' \\\n')
}
