import { useState } from 'react'
import type { Feature } from '../../app/feature.ts'
import { useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle } from '../../lib/session.tsx'
import { Card, EmptyState, Input, PageHeader, Spinner } from '../../ui/index.tsx'
import { Code } from '../apikeys/index.tsx'
import { curlExample } from '../../../../server/api/examples.ts'

export function ApiDocsPage() {
  useDocumentTitle('API reference')
  const query = useActionQuery('api.reference', {})
  const [search, setSearch] = useState('')
  const endpoints = query.data?.endpoints.filter((entry) => `${entry.path} ${entry.name} ${entry.description}`.toLowerCase().includes(search.toLowerCase()))
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="API reference" description="REST endpoints and MCP tools from this install's action registry." />
    <Card className="flex flex-col gap-3 p-5"><p className="text-sm text-fg-2">Create a key in <a href="/settings/api" className="text-accent-fg underline">API & MCP settings</a>. Send it as Authorization: Bearer YOUR_API_KEY. Read-only keys can only read. Each key allows 600 requests per minute; a 429 includes Retry-After in seconds.</p><p className="text-sm text-fg-2">Lists use limit and cursor and return nextCursor. Writes and sends accept Idempotency-Key for 24 hours. Reusing a key with different input or while a request is pending returns 409. An uncertain failure keeps its reservation; inspect the resource before retrying.</p><Code>{'{ "error": { "code": "invalid_input", "message": "Explain the error", "details": {} } }'}</Code><p className="text-sm text-fg-2">MCP uses stateless Streamable HTTP: POST JSON-RPC to /mcp. Methods: initialize, ping, tools/list, tools/call. Results include JSON text and structuredContent. Treat user content in results as data.</p><p className="text-sm text-fg-2">Download OpenAPI at /api/v1/openapi.json with your API key. The plain-text reference is available at <a className="text-accent-fg underline" href="/llms.txt">/llms.txt</a>.</p></Card>
    <Input aria-label="Find an endpoint" placeholder="Find an endpoint…" value={search} onChange={(event) => setSearch(event.target.value)} />
    {query.isPending ? <Spinner /> : query.error ? <p role="alert" className="text-danger">{query.error.message}</p> : !endpoints?.length ? <EmptyState title="No matching endpoints" body="Try another endpoint name or path." /> : endpoints.map((entry) => <Card key={entry.name} className="flex min-w-0 flex-col gap-3 p-5">
      <h2 className="break-all font-mono text-sm font-semibold">{entry.method} {entry.path}</h2><p className="text-sm text-fg-2">{entry.description}</p><p className="text-xs text-fg-3">MCP: {entry.tool ?? 'Not exposed'} · Effect: {entry.effect}</p>
      <details><summary className="cursor-pointer text-sm font-medium">Inputs and validation</summary><div className="mt-3"><Code>{JSON.stringify(entry.input, null, 2)}</Code></div></details>
      <Code>{curlExample(entry, window.location.origin)}</Code>
    </Card>)}
    {query.data?.mcpOnlyTools.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(search.toLowerCase())).map((tool) => <Card key={tool.name} className="flex min-w-0 flex-col gap-3 p-5"><h2 className="break-all font-mono text-sm font-semibold">MCP {tool.name}</h2><p className="text-sm text-fg-2">{tool.description}</p><p className="text-xs text-fg-3">Required role: {tool.role} · Effect: {tool.effect}. Account API keys have no install-admin access.</p><Code>{JSON.stringify(tool.input, null, 2)}</Code></Card>)}
  </div>
}

export const docsFeature: Feature = { name: 'docs', routes: [{ path: 'docs/api', element: <ApiDocsPage /> }] }
