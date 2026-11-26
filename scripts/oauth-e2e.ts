/**
 * End-to-end check of OAuth for MCP in a real browser: discovery, registration, sign-in and consent,
 * code exchange with PKCE, tools/list, refresh, revocation, and an API key on /mcp.
 *
 *   npx tsx scripts/oauth-e2e.ts                 starts `wrangler dev` on a free port with fresh storage
 *   npx tsx scripts/oauth-e2e.ts --base <url>    runs against a running install; needs OAUTH_E2E_EMAIL_FILE
 *                                                and OAUTH_E2E_PASSWORD_FILE (files, so nothing lands in argv)
 *
 * It prints what it checked, never a token, code or password.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : ''

const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port
    server.close(() => resolve(port))
  })
})
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`  ok  ${what}`)
}

async function startWrangler(): Promise<{ base: string; child: ChildProcess; persist: string }> {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcorgi-oauth-e2e-'))
  const child = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(await freePort()), '--persist-to', persist, '--var', `APP_URL:${base}`, '--show-interactive-dev-session=false', '--log-level', 'warn'], { cwd: root, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore', detached: true })
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, child, persist } } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('wrangler dev did not start')
}

/** A session for API calls the web app would make, so the script can create and revoke an API key. */
async function session(base: string, email: string, password: string) {
  const r = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  if (!r.ok) throw new Error(`sign-in failed with ${r.status}`)
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const boot = await (await fetch(`${base}/api/auth/bootstrap`, { headers: { cookie } })).json() as { session: { csrf: string } }
  return (name: string, input: unknown) => fetch(`${base}/api/actions/${name}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-mc-csrf': boot.session.csrf }, body: JSON.stringify(input) })
}

async function main() {
  let server: Awaited<ReturnType<typeof startWrangler>> | null = null
  let email: string
  let password: string
  let base = baseArg.replace(/\/$/, '')
  if (base) {
    email = fs.readFileSync(process.env.OAUTH_E2E_EMAIL_FILE!, 'utf8').trim()
    password = fs.readFileSync(process.env.OAUTH_E2E_PASSWORD_FILE!, 'utf8').replace(/\n$/, '')
  } else {
    server = await startWrangler()
    base = server.base
    email = 'owner@example.com'
    password = 'correct horse battery staple'
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Owner', password }) })
    if (!setup.ok) throw new Error(`setup failed with ${setup.status}`)
    await (await session(base, email, password))('newsletters.create', { name: 'E2E', slug: 'e2e' })
  }
  console.log(`OAuth e2e against ${base}`)
  const callbackPort = await freePort()
  const redirectUri = `http://127.0.0.1:${callbackPort}/callback`
  let callback: URL | null = null
  const cb = http.createServer((req, res) => {
    callback = new URL(req.url!, redirectUri)
    res.end('You can close this tab.')
  }).listen(callbackPort, '127.0.0.1')
  const browser = await chromium.launch()
  const act = await session(base, email, password)
  let keyId = ''
  try {
    // 1. Discovery
    const bare = await fetch(`${base}/mcp`)
    check(bare.status === 401, 'GET /mcp without auth is 401')
    check(bare.headers.get('www-authenticate') === `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`, `WWW-Authenticate: ${bare.headers.get('www-authenticate')}`)
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()
    check(prm.resource === `${base}/mcp` && prm.authorization_servers[0] === base, 'protected resource metadata is valid JSON')
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()
    check(asm.issuer === base && asm.code_challenge_methods_supported.includes('S256') && asm.registration_endpoint, 'authorization server metadata is valid JSON')

    // 2. Registration
    const reg = await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'OAuth e2e', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) })
    const client = await reg.json()
    check(reg.status === 201 && client.client_id, 'dynamic client registration (public client)')

    // 3. Authorize in a browser: sign in, then approve
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(12))
    const authorize = new URL(asm.authorization_endpoint)
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'mail:full', resource: prm.resource })) authorize.searchParams.set(k, v)
    const page = await (await browser.newContext()).newPage()
    await page.goto(authorize.toString())
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('heading', { name: 'Connect OAuth e2e' }).waitFor({ timeout: 20_000 })
    check(true, 'signed out → sign-in form → consent screen')
    await page.screenshot({ path: path.join(os.tmpdir(), 'mailcorgi-oauth-consent.png') })
    await page.getByRole('button', { name: 'Approve' }).click()
    for (let i = 0; i < 100 && !callback; i++) await new Promise((r) => setTimeout(r, 100))
    const back = callback as URL | null
    check(back?.searchParams.get('code') && back.searchParams.get('state') === state && back.searchParams.get('iss') === base, 'approve redirects with code, state and iss')

    // 4. Token exchange
    const form = (body: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })
    const tok = await fetch(asm.token_endpoint, form({ grant_type: 'authorization_code', code: back!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id, resource: prm.resource }))
    const tokens = await tok.json()
    check(tok.status === 200 && tokens.token_type === 'Bearer' && tokens.expires_in === 3600 && tokens.scope === 'mail:full', 'code exchange with PKCE returns a 1-hour Bearer token')
    const reuse = await fetch(asm.token_endpoint, form({ grant_type: 'authorization_code', code: back!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id }))
    check(reuse.status === 400, 'the code is single use')

    // 5. MCP with the access token
    const mcp = (token: string, method: string, params?: unknown) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) })
    // The replayed code above revoked that grant, so connect again for the rest of the run.
    callback = null
    const state2 = b64url(randomBytes(12))
    authorize.searchParams.set('state', state2)
    await page.goto(authorize.toString())
    await page.getByRole('button', { name: 'Approve' }).click()
    for (let i = 0; i < 100 && !callback; i++) await new Promise((r) => setTimeout(r, 100))
    const back2 = callback as URL | null
    check(back2?.searchParams.get('state') === state2, 'a second approval needs no new sign-in')
    const fresh = await (await fetch(asm.token_endpoint, form({ grant_type: 'authorization_code', code: back2!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id }))).json()
    const list = await mcp(fresh.access_token, 'tools/list')
    const tools = (await list.json()).result?.tools ?? []
    check(list.status === 200 && tools.length > 0, `tools/list with the OAuth token returns ${tools.length} tools`)

    // 6. Refresh with rotation
    const ref = await fetch(asm.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: client.client_id }))
    const next = await ref.json()
    check(ref.status === 200 && next.refresh_token !== fresh.refresh_token, 'refresh returns a new access token and a rotated refresh token')
    check((await mcp(next.access_token, 'tools/list')).status === 200, 'the refreshed access token works on /mcp')

    // 7. Connected apps and revocation
    const apps = await (await act('oauth.listApps', {})).json()
    check(apps.apps.some((a: { name: string }) => a.name === 'OAuth e2e'), 'Settings → Connected apps lists the client')
    const rev = await fetch(asm.revocation_endpoint, form({ token: next.refresh_token, client_id: client.client_id }))
    check(rev.status === 200 && (await mcp(next.access_token, 'tools/list')).status === 401, 'revoking the refresh token ends access')

    // 8. API keys still work
    const key = await (await act('apikeys.create', { name: 'OAuth e2e check', access: 'read' })).json()
    keyId = key.id
    check((await mcp(key.secret, 'tools/list')).status === 200, 'an API key still works on /mcp')
    check((await fetch(`${base}/api/v1/newsletters`, { headers: { authorization: `Bearer ${key.secret}` } })).status === 200, 'an API key still works on /api/v1')
    console.log('OAuth e2e passed')
  } finally {
    if (keyId) await act('apikeys.revoke', { keyId })
    await browser.close()
    cb.close()
    if (server) {
      try { process.kill(-server.child.pid!, 'SIGTERM') } catch {}
      fs.rmSync(server.persist, { recursive: true, force: true })
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
