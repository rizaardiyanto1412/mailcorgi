import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nodeAssets } from '../platform-node.ts'
import { withSpaFallback } from '../edge/assets.ts'
import { createInstall } from './harness.ts'

const root = path.resolve(import.meta.dirname, '../..')

function webRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-web-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>')
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'export {}')
  fs.writeFileSync(path.join(dir, 'assets', 'chunk'), 'x')
  fs.writeFileSync(path.join(dir, '_headers'), '/assets/*\n  Cache-Control: immutable\n')
  return dir
}

test('Node: a missing file under /assets/ is a 404, never the SPA shell', async () => {
  const serve = nodeAssets(webRoot())
  for (const p of ['/assets/index-old999.js', '/assets/old-chunk', '/assets/']) {
    const r = await serve(new Request('http://app.example.com' + p))
    assert.equal(r.status, 404, p)
    assert.doesNotMatch(r.headers.get('content-type') ?? '', /html/, p)
  }
  const hashed = await serve(new Request('http://app.example.com/assets/index-abc123.js'))
  assert.equal(hashed.status, 200)
  assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  const route = await serve(new Request('http://app.example.com/campaigns/abc'))
  assert.equal(route.status, 200)
  assert.match(route.headers.get('content-type') ?? '', /text\/html/)
  assert.equal(route.headers.get('cache-control'), 'no-cache')
  assert.equal((await serve(new Request('http://app.example.com/_headers'))).status, 404)
})

test('Workers: the SPA fallback serves the shell for routes and keeps 404s for files', async () => {
  const seen: string[] = []
  const files: Record<string, string> = { '/': '<!doctype html>', '/assets/index-abc123.js': 'export {}' }
  const fetchAsset = async (request: Request) => {
    const p = new URL(request.url).pathname
    seen.push(p)
    return p in files ? new Response(files[p], { headers: { 'content-type': p === '/' ? 'text/html' : 'text/javascript' } }) : new Response(null, { status: 404 })
  }
  const assets = withSpaFallback(fetchAsset)
  assert.equal((await assets(new Request('https://app.example.com/campaigns/abc'))).status, 200)
  assert.deepEqual(seen, ['/campaigns/abc', '/'])
  for (const p of ['/assets/index-old999.js', '/assets/old', '/missing.png']) {
    seen.length = 0
    assert.equal((await assets(new Request('https://app.example.com' + p))).status, 404, p)
    assert.deepEqual(seen, [p])
  }
  assert.equal((await assets(new Request('https://app.example.com/x', { method: 'POST' }))).status, 404)
})

test('the built web output makes /assets/* immutable for a year on Cloudflare', () => {
  const headers = fs.readFileSync(path.join(root, 'web/public/_headers'), 'utf8')
  assert.match(headers, /^\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m)
  const wrangler = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')
  assert.match(wrangler, /"not_found_handling": "none"/, 'a missing /assets/ file must not get the SPA shell')
  assert.match(wrangler, /"run_worker_first": \["\/\*", "!\/assets\/\*"\]/)
})

test('HSTS is sent when the app URL is https, and not for http or localhost', async () => {
  const cases: [string, string, string | null][] = [
    ['https://news.example.com', 'https://news.example.com/healthz', 'max-age=31536000'],
    ['http://news.example.com', 'http://news.example.com/healthz', null],
    ['https://localhost:3000', 'https://localhost:3000/healthz', null],
    ['', 'https://news.example.com/healthz', 'max-age=31536000'],
    ['', 'http://127.0.0.1:3000/healthz', null],
  ]
  for (const [appUrl, url, expected] of cases) {
    const install = await createInstall({ env: { APP_URL: appUrl } })
    try {
      const r = await install.fetch(url)
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('strict-transport-security'), expected, `${appUrl || '(learned)'} ${url}`)
      const api = await install.fetch(url.replace('/healthz', '/api/nothing'))
      assert.equal(api.headers.get('strict-transport-security'), expected)
    } finally {
      install.close()
    }
  }
})

test('Node behind a trusted proxy sends HSTS when the proxy says https', async () => {
  const install = await createInstall({ env: { APP_URL: '', TRUST_PROXY: '10.0.0.5' } })
  try {
    const viaProxy = await install.app.edge.fetch(new Request('http://news.example.com/healthz', { headers: { 'x-forwarded-proto': 'https' } }), '10.0.0.5')
    assert.equal(viaProxy.headers.get('strict-transport-security'), 'max-age=31536000')
    const direct = await install.app.edge.fetch(new Request('http://news.example.com/healthz', { headers: { 'x-forwarded-proto': 'https' } }), '203.0.113.9')
    assert.equal(direct.headers.get('strict-transport-security'), null)
  } finally {
    install.close()
  }
})
