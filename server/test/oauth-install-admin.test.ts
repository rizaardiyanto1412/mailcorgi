import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { APP_URL, createInstall, type Client, type Install, type InstallOptions } from './harness.ts'

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })

async function start(t: TestContext, opts: InstallOptions = {}) {
  const install = await createInstall(opts)
  t.after(() => install.close())
  return install
}

/** Register a client, approve it as `user` on the consent screen, and exchange the code for an access token. */
async function connect(install: Install, user: Client, scope: 'mail:read' | 'mail:full' = 'mail:full') {
  const registered = await install.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Client', redirect_uris: ['https://client.example.com/cb'] }) })
  assert.equal(registered.status, 201)
  const client = (await registered.json()) as { client_id: string }
  const verifier = b64url(randomBytes(32))
  const request = { origin: APP_URL, client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', response_type: 'code', code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 's', resource: `${APP_URL}/mcp`, scope }
  assert.equal((await user.action('oauth.describe', request)).ok, true)
  const { redirect } = await user.action('oauth.decide', { ...request, approve: true, accountId: user.accountId! })
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: new URL(redirect).searchParams.get('code')!, code_verifier: verifier, redirect_uri: request.redirect_uri, client_id: client.client_id, resource: request.resource })
  const r = await install.fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  assert.equal(r.status, 200, await r.clone().text())
  const tokens = (await r.json()) as { access_token: string; scope: string }
  assert.equal(tokens.scope, scope)
  return tokens.access_token
}

async function callTool(install: Install, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await install.fetch('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: rpc('tools/call', { name, arguments: args }) })
  assert.equal(r.status, 200)
  return (await r.json()).result as { isError: boolean; structuredContent: any }
}

async function assertForbidden(install: Install, token: string) {
  for (const [name, args] of [['install_settings_get', {}], ['install_settings_set', { values: { email_from_name: 'Nope' } }]] as const) {
    const result = await callTool(install, token, name, args)
    assert.equal(result.isError, true, name)
    assert.equal(result.structuredContent.error.code, 'forbidden', name)
  }
}

async function assertReadsAndWrites(install: Install, token: string, admin: Client) {
  const before = await callTool(install, token, 'install_settings_get')
  assert.equal(before.isError, false, JSON.stringify(before))
  assert.equal(before.structuredContent.values.email_from_name, '')
  const set = await callTool(install, token, 'install_settings_set', { values: { email_from_name: 'Corgi Post', resend_api_key: 're_not_a_real_key' } })
  assert.equal(set.isError, false, JSON.stringify(set))
  const after = await callTool(install, token, 'install_settings_get')
  const settings = after.structuredContent
  assert.equal(settings.values.email_from_name, 'Corgi Post')
  assert.equal(settings.secretsSet.resend_api_key, true)
  assert.equal('resend_api_key' in settings.values, false, 'a secret is only a flag')
  assert.doesNotMatch(JSON.stringify(after), /re_not_a_real_key/)
  assert.ok(Array.isArray(settings.missing))
  assert.equal(typeof settings.fromEnv.email_from_name, 'boolean')
  assert.equal(settings.webhookUrls.resend, `${APP_URL}/hooks/resend`)
  assert.equal((await admin.action('install.settings.get', {})).values.email_from_name, 'Corgi Post', 'the web session sees the same store')
}

test('self-hosted: the install admin\'s OAuth session can read and change install settings over MCP', async (t) => {
  const install = await start(t)
  const admin = await install.signUp({ email: 'owner@example.com' })
  assert.equal(admin.session.user.isInstallAdmin, true)
  const token = await connect(install, admin)
  const tools = (await (await install.fetch('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: rpc('tools/list') })).json()).result.tools as { name: string; annotations: { readOnlyHint: boolean } }[]
  assert.equal(tools.find((tool) => tool.name === 'install_settings_get')?.annotations.readOnlyHint, true)
  await assertReadsAndWrites(install, token, admin)
})

test('a mail:read OAuth session of the install admin can read install settings but not change them', async (t) => {
  const install = await start(t)
  const admin = await install.signUp({ email: 'owner@example.com' })
  const token = await connect(install, admin, 'mail:read')
  assert.equal((await callTool(install, token, 'install_settings_get')).isError, false)
  const set = await callTool(install, token, 'install_settings_set', { values: { email_from_name: 'Nope' } })
  assert.equal(set.structuredContent.error.code, 'forbidden')
  assert.equal((await admin.action('install.settings.get', {})).values.email_from_name, '')
})

test('a user who is not an install admin gets forbidden through OAuth, and so does a disabled admin', async (t) => {
  const install = await start(t, { env: { ALLOWED_EMAILS: 'member@example.com' } })
  const admin = await install.signUp({ email: 'owner@example.com' })
  const member = await install.signUp({ email: 'member@example.com' })
  assert.equal(member.session.user.isInstallAdmin, false)
  await assertForbidden(install, await connect(install, member))

  const adminToken = await connect(install, admin)
  assert.equal((await callTool(install, adminToken, 'install_settings_get')).isError, false)
  install.app.control.ctx.db.run('UPDATE users SET disabled = 1 WHERE id = ?', admin.session.user.id)
  await assertForbidden(install, adminToken)
})

test('an install admin\'s API key on /mcp still has no install-admin access', async (t) => {
  const install = await start(t)
  const admin = await install.signUp({ email: 'owner@example.com' })
  const key = await admin.action('apikeys.create', { name: 'Full', access: 'full' })
  await assertForbidden(install, key.secret)
  assert.equal((await admin.action('install.settings.get', {})).values.email_from_name, '')
})

test('cloud: a verified ADMIN_EMAILS user is an install admin through OAuth, another user is not', async (t) => {
  const install = await start(t, { cloud: true, env: { ADMIN_EMAILS: 'owner@example.com' } })
  const admin = await install.signUp({ email: 'owner@example.com' })
  assert.equal(admin.session.user.isInstallAdmin, true)
  await assertReadsAndWrites(install, await connect(install, admin), admin)
  const other = await install.signUp({ email: 'other@example.com' })
  assert.equal(other.session.user.isInstallAdmin, false)
  await assertForbidden(install, await connect(install, other))
})
