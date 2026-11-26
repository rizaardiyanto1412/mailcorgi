import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { APP_URL, createInstall, type Client, type Install } from './harness.ts'

let install: Install
let owner: Client
before(async () => {
  install = await createInstall({ env: { APP_HOSTS: 'alias.example.org', ALLOWED_EMAILS: 'member@example.com' } })
  owner = await install.signUp({ email: 'owner@example.com' })
  await owner.action('newsletters.create', { name: 'Weekly', slug: 'weekly' })
})
after(() => install.close())

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const pkce = () => {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}
const form = (body: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })
const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })
const callMcp = (token: string, body: string, host = APP_URL) => install.fetch(`${host}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body })

async function registerClient(extra: Record<string, unknown> = {}) {
  const r = await install.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Client', redirect_uris: ['http://127.0.0.1:33418/callback', 'https://client.example.com/cb'], ...extra }) })
  assert.equal(r.status, 201)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  return r.json() as Promise<{ client_id: string; client_secret?: string }>
}

/** Register, approve on the consent screen as the owner, and exchange the code. */
async function connect(opts: { scope?: string; grantScope?: 'mail:read' | 'mail:full'; origin?: string; secret?: boolean } = {}) {
  const origin = opts.origin ?? APP_URL
  const client = await registerClient(opts.secret ? { token_endpoint_auth_method: 'client_secret_post' } : {})
  const { verifier, challenge } = pkce()
  const request = { origin, client_id: client.client_id, redirect_uri: 'http://127.0.0.1:51234/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz-123', resource: `${origin}/mcp`, ...(opts.scope ? { scope: opts.scope } : {}) }
  const described = await owner.action('oauth.describe', request)
  assert.equal(described.ok, true)
  const { redirect } = await owner.action('oauth.decide', { ...request, approve: true, accountId: owner.accountId!, ...(opts.grantScope ? { grantScope: opts.grantScope } : {}) })
  const back = new URL(redirect)
  assert.equal(back.origin + back.pathname, 'http://127.0.0.1:51234/callback', 'a loopback redirect may use another port')
  assert.equal(back.searchParams.get('state'), 'xyz-123')
  assert.equal(back.searchParams.get('iss'), origin)
  const code = back.searchParams.get('code')!
  const tokenRequest = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: request.redirect_uri, client_id: client.client_id, resource: `${origin}/mcp`, ...(client.client_secret ? { client_secret: client.client_secret } : {}) }
  const r = await install.fetch(`${origin}/oauth/token`, form(tokenRequest))
  assert.equal(r.status, 200, await r.clone().text())
  assert.equal(r.headers.get('cache-control'), 'no-store')
  return { client, tokens: (await r.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string }, tokenRequest }
}

test('/mcp without a token is a 401 that points at the protected resource metadata', async () => {
  for (const init of [{}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc('tools/list') }]) {
    const r = await install.fetch('/mcp', init)
    assert.equal(r.status, 401)
    assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`)
  }
  const bad = await callMcp('mca_acc_aaaaaaaaaaaaaaaa_' + 'x'.repeat(43), rpc('tools/list'))
  assert.equal(bad.status, 401)
  assert.match(bad.headers.get('www-authenticate')!, /error="invalid_token"/)
  const alias = await install.fetch('https://alias.example.org/mcp')
  assert.equal(alias.headers.get('www-authenticate'), 'Bearer resource_metadata="http://alias.example.org/.well-known/oauth-protected-resource"', 'an alias uses the APP_URL scheme')
})

test('discovery documents are JSON with CORS', async () => {
  const pr = await install.fetch('/.well-known/oauth-protected-resource')
  assert.equal(pr.status, 200)
  assert.equal(pr.headers.get('access-control-allow-origin'), '*')
  const resource = await pr.json()
  assert.equal(resource.resource, `${APP_URL}/mcp`)
  assert.deepEqual(resource.authorization_servers, [APP_URL])
  assert.deepEqual(resource.scopes_supported, ['mail:read', 'mail:full'])
  assert.deepEqual(await (await install.fetch('/.well-known/oauth-protected-resource/mcp')).json(), resource)
  const as = await (await install.fetch('/.well-known/oauth-authorization-server')).json()
  assert.equal(as.issuer, APP_URL)
  assert.equal(as.authorization_endpoint, `${APP_URL}/oauth/authorize`)
  assert.equal(as.token_endpoint, `${APP_URL}/oauth/token`)
  assert.equal(as.registration_endpoint, `${APP_URL}/oauth/register`)
  assert.equal(as.revocation_endpoint, `${APP_URL}/oauth/revoke`)
  assert.deepEqual(as.response_types_supported, ['code'])
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token'])
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none', 'client_secret_post'])
  const aliasAs = await (await install.fetch('https://alias.example.org/.well-known/oauth-authorization-server')).json()
  assert.equal(aliasAs.issuer, 'http://alias.example.org')
  for (const path of ['/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/register', '/oauth/revoke']) {
    const pre = await install.fetch(path, { method: 'OPTIONS', headers: { origin: 'https://client.example.com', 'access-control-request-method': 'POST' } })
    assert.equal(pre.status, 204, path)
    assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  }
  assert.equal((await install.fetch('https://random.example.com/.well-known/oauth-authorization-server')).status, 404, 'only app hosts are authorization servers')
})

test('registration accepts https, loopback and app schemes; refuses the rest', async () => {
  const ok = await registerClient({ redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback', 'http://localhost:3000/cb', 'http://[::1]/cb'] })
  assert.match(ok.client_id, /^mcl_/)
  assert.equal(ok.client_secret, undefined, 'public clients get no secret')
  for (const uri of ['http://evil.example.com/cb', 'javascript:alert(1)', 'https://client.example.com/cb#frag', 'not a url']) {
    const r = await install.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Bad', redirect_uris: [uri] }) })
    assert.equal(r.status, 400, uri)
    assert.equal((await r.json()).error, 'invalid_redirect_uri')
  }
  const missing = await install.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'None' }) })
  assert.equal(missing.status, 400)
})

test('full flow: register, approve with PKCE, exchange, tools/list, refresh with rotation, revoke', async () => {
  const { client, tokens } = await connect({ scope: 'mail:full' })
  assert.match(tokens.access_token, /^mca_acc_/)
  assert.match(tokens.refresh_token, /^mcr_acc_/)
  assert.equal(tokens.token_type, 'Bearer')
  assert.equal(tokens.expires_in, 3600)
  assert.equal(tokens.scope, 'mail:full')

  const list = await callMcp(tokens.access_token, rpc('tools/list'))
  assert.equal(list.status, 200)
  const tools = (await list.json()).result.tools as { name: string }[]
  assert.ok(tools.length > 10)
  const created = await (await callMcp(tokens.access_token, rpc('tools/call', { name: 'newsletters_create', arguments: { name: 'Via OAuth', slug: 'via-oauth' } }))).json()
  assert.equal(created.result.isError, false, JSON.stringify(created.result))

  const refreshed = await install.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))
  assert.equal(refreshed.status, 200)
  const next = await refreshed.json()
  assert.notEqual(next.refresh_token, tokens.refresh_token, 'refresh tokens rotate')
  assert.equal((await callMcp(next.access_token, rpc('tools/list'))).status, 200)

  // Reusing the old refresh token means it leaked: the whole grant ends.
  const replay = await install.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))
  assert.equal(replay.status, 400)
  assert.equal((await replay.json()).error, 'invalid_grant')
  assert.equal((await callMcp(next.access_token, rpc('tools/list'))).status, 401)
  assert.equal((await install.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: client.client_id }))).status, 400)
})

test('codes are single use, expire, and need the right verifier, client and redirect', async () => {
  const { tokenRequest, tokens } = await connect()
  const again = await install.fetch('/oauth/token', form(tokenRequest))
  assert.equal(again.status, 400)
  assert.equal((await again.json()).error, 'invalid_grant')
  assert.equal((await callMcp(tokens.access_token, rpc('tools/list'))).status, 401, 'a replayed code revokes what it issued')

  const client = await registerClient()
  const { verifier, challenge } = pkce()
  const request = { origin: APP_URL, client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's' }
  const codeFor = async () => new URL((await owner.action('oauth.decide', { ...request, approve: true, accountId: owner.accountId! })).redirect).searchParams.get('code')!
  const base = { grant_type: 'authorization_code', redirect_uri: request.redirect_uri, client_id: client.client_id }
  const wrongVerifier = await install.fetch('/oauth/token', form({ ...base, code: await codeFor(), code_verifier: pkce().verifier }))
  assert.equal((await wrongVerifier.json()).error, 'invalid_grant')
  const wrongRedirect = await install.fetch('/oauth/token', form({ ...base, code: await codeFor(), code_verifier: verifier, redirect_uri: 'https://client.example.com/other' }))
  assert.equal((await wrongRedirect.json()).error, 'invalid_grant')
  const wrongClient = await install.fetch('/oauth/token', form({ ...base, code: await codeFor(), code_verifier: verifier, client_id: (await registerClient()).client_id }))
  assert.equal((await wrongClient.json()).error, 'invalid_grant')
  const wrongResource = await install.fetch('/oauth/token', form({ ...base, code: await codeFor(), code_verifier: verifier, resource: 'https://elsewhere.example.com/mcp' }))
  assert.equal((await wrongResource.json()).error, 'invalid_target')
  const late = await codeFor()
  install.clock.advance(11 * 60_000)
  assert.equal((await (await install.fetch('/oauth/token', form({ ...base, code: late, code_verifier: verifier }))).json()).error, 'invalid_grant', 'codes last about 10 minutes')
  const ok = await install.fetch('/oauth/token', form({ ...base, code: await codeFor(), code_verifier: verifier }))
  assert.equal(ok.status, 200)
})

test('access tokens expire after an hour and only work on the host that issued them', async () => {
  const { tokens } = await connect({ origin: 'http://alias.example.org' })
  assert.equal((await callMcp(tokens.access_token, rpc('tools/list'), 'http://alias.example.org')).status, 200)
  assert.equal((await callMcp(tokens.access_token, rpc('tools/list'), APP_URL)).status, 401, 'the audience is the /mcp URL it was issued for')
  install.clock.advance(61 * 60_000)
  assert.equal((await callMcp(tokens.access_token, rpc('tools/list'), 'http://alias.example.org')).status, 401)
})

test('authorization requests are checked before anything is issued', async () => {
  const client = await registerClient()
  const { challenge } = pkce()
  const good = { origin: APP_URL, client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st' }
  // Client and redirect problems are shown to the user, never sent to the redirect URI.
  assert.equal((await owner.actionRaw('oauth.describe', { ...good, client_id: 'mcl_unknown' })).status, 400)
  assert.equal((await owner.actionRaw('oauth.describe', { ...good, redirect_uri: 'https://evil.example.com/cb' })).status, 400)
  assert.equal((await owner.actionRaw('oauth.describe', { ...good, origin: 'https://random.example.com' })).status, 400)
  // Everything else goes back to the client as an OAuth error.
  for (const [patch, error] of [[{ code_challenge_method: 'plain' }, 'invalid_request'], [{ code_challenge: '' }, 'invalid_request'], [{ response_type: 'token' }, 'unsupported_response_type'], [{ scope: 'admin' }, 'invalid_scope'], [{ resource: 'https://elsewhere.example.com/mcp' }, 'invalid_target']] as const) {
    const described = await owner.action('oauth.describe', { ...good, ...patch })
    assert.equal(described.ok, false)
    const back = new URL((described as { redirect: string }).redirect)
    assert.equal(back.searchParams.get('error'), error)
    assert.equal(back.searchParams.get('state'), 'st')
  }
  const denied = new URL((await owner.action('oauth.decide', { ...good, approve: false })).redirect)
  assert.equal(denied.searchParams.get('error'), 'access_denied')
  assert.equal(denied.searchParams.get('code'), null)
  const notOwner = await install.signUp({ email: 'member@example.com' })
  const other = await notOwner.actionRaw('oauth.decide', { ...good, approve: true, accountId: owner.accountId! })
  assert.equal(other.status, 403, 'only the owner of an account can connect it')
  const escalate = await owner.actionRaw('oauth.decide', { ...good, scope: 'mail:read', approve: true, accountId: owner.accountId!, grantScope: 'mail:full' })
  assert.equal(escalate.status, 400)
})

test('mail:read tokens are read-only, like a read-only API key', async () => {
  const { tokens } = await connect({ scope: 'mail:full', grantScope: 'mail:read' })
  assert.equal(tokens.scope, 'mail:read')
  const read = await (await callMcp(tokens.access_token, rpc('tools/call', { name: 'newsletters_list', arguments: {} }))).json()
  assert.equal(read.result.isError, false)
  const write = await (await callMcp(tokens.access_token, rpc('tools/call', { name: 'newsletters_create', arguments: { name: 'Nope', slug: 'nope' } }))).json()
  assert.equal(write.result.isError, true)
  assert.equal(write.result.structuredContent.error.code, 'forbidden')
})

test('confidential clients must send their secret', async () => {
  const { client, tokens } = await connect({ secret: true })
  assert.ok(client.client_secret)
  const noSecret = await install.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))
  assert.equal(noSecret.status, 401)
  assert.equal((await noSecret.json()).error, 'invalid_client')
})

test('revocation and the connected apps list', async () => {
  const { client, tokens } = await connect()
  const listed = await owner.action('oauth.listApps', {})
  const app = listed.apps.find((a) => a.name === 'Test Client' && a.host === new URL(APP_URL).host)
  assert.ok(app)
  // RFC 7009: revoking the refresh token ends the grant.
  const r = await install.fetch('/oauth/revoke', form({ token: tokens.refresh_token, client_id: client.client_id }))
  assert.equal(r.status, 200)
  assert.equal((await callMcp(tokens.access_token, rpc('tools/list'))).status, 401)
  assert.equal((await install.fetch('/oauth/revoke', form({ token: 'garbage' }))).status, 200, 'unknown tokens still answer 200')

  const second = await connect()
  for (const listedApp of (await owner.action('oauth.listApps', {})).apps) await owner.action('oauth.revokeApp', { grantId: listedApp.id })
  assert.deepEqual((await owner.action('oauth.listApps', {})).apps, [])
  assert.equal((await callMcp(second.tokens.access_token, rpc('tools/list'))).status, 401, 'disconnecting in settings stops the token at once')
})

test('API keys keep working on /mcp and the REST API; OAuth tokens do not reach REST', async () => {
  const key = await owner.action('apikeys.create', { name: 'Old key', access: 'full' })
  const r = await callMcp(key.secret, rpc('tools/list'))
  assert.equal(r.status, 200)
  assert.equal((await install.fetch('/api/v1/newsletters', { headers: { authorization: `Bearer ${key.secret}` } })).status, 200)
  const { tokens } = await connect()
  assert.equal((await install.fetch('/api/v1/newsletters', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401)
})

test('an OAuth connection is limited to 600 requests a minute', async () => {
  const { tokens } = await connect()
  let status = 200
  for (let i = 0; i < 601 && status === 200; i++) status = (await callMcp(tokens.access_token, rpc('ping'))).status
  assert.equal(status, 429)
})
