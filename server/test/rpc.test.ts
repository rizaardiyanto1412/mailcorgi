import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, type Client, type Install } from './harness.ts'
import { AppError } from '../core/http.ts'
import { pushPolicy } from '../control/accounts/index.ts'
import { getPolicy } from '../account/usage/index.ts'
import { decodeRpcResult, encodeRpcError } from '../core/store.ts'

let install: Install
let owner: Client
before(async () => {
  install = await createInstall()
  owner = await install.signUp({ email: 'owner@example.com' })
})
after(() => install.close())

test('an unknown RPC fails with a 404 AppError', async () => {
  await assert.rejects(install.app.stores.control.nothing({}), (err: AppError) => err instanceof AppError && err.status === 404)
})

test('AppErrors keep their code across the RPC boundary', async () => {
  const encoded = encodeRpcError(new AppError('slug_taken', 'Taken.', 409))
  assert.throws(() => decodeRpcResult(encoded), (err: AppError) => err.code === 'slug_taken' && err.status === 409)
  assert.deepEqual(decodeRpcResult({ ok: true, result: 5 }), 5)
})

test('bootstrap is idempotent and the account store knows its owner', async () => {
  const ctx = install.app.account(owner.accountId!).ctx
  await install.app.stores.account(owner.accountId!).bootstrap({ accountId: owner.accountId!, ownerUserId: 'someone-else', ownerEmail: 'other@example.com', policy: getPolicy(ctx) })
  assert.equal(ctx.db.get<{ value: string }>("SELECT value FROM account_meta WHERE key = 'owner_email'")?.value, 'owner@example.com')
  assert.equal(ctx.db.get<{ value: string }>("SELECT value FROM account_meta WHERE key = 'token_key'")?.value.length, 64)
})

test('a block is pushed through a job and the account store ignores older versions', async () => {
  const ctx = install.app.account(owner.accountId!).ctx
  const before = getPolicy(ctx)
  assert.equal(before.status, 'active')
  pushPolicy(install.app.control.ctx, owner.accountId!, { status: 'blocked', block_reason: 'test' })
  assert.equal(getPolicy(ctx).status, 'active', 'nothing changes until the job runs')
  await install.runJobs()
  const after = getPolicy(ctx)
  assert.equal(after.status, 'blocked')
  assert.equal(after.version, before.version + 1)
  const stale = await install.app.stores.account(owner.accountId!).applyPolicy({ ...before, status: 'active' })
  assert.equal(stale.applied, false)
  assert.equal(getPolicy(ctx).status, 'blocked')
  pushPolicy(install.app.control.ctx, owner.accountId!, { status: 'active', block_reason: null })
  await install.runJobs()
  assert.equal(getPolicy(ctx).status, 'active')
})

test('the account summary RPC counts newsletters', async () => {
  await owner.action('newsletters.create', { name: 'Counted' })
  const summary = await install.app.stores.account(owner.accountId!).summary({})
  assert.equal(summary.newsletters, 1)
})
