import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createInstall } from './harness.ts'

test('untrusted account prefixes never provision account databases', async () => {
  const install = await createInstall({ cloud: true })
  try {
    const id = 'acc_aaaaaaaaaaaaaaaa'
    for (const path of [`/u/${id}.x`, `/f/nl_${id}_aaaaaaaaaaaaaaaa`, '/api/v1/newsletters', `/img/${id}/x`]) {
      assert.equal((await install.fetch(path, { headers: { authorization: `Bearer mc_${id}_abcdefghijklmnopqrst` } })).status, 404)
    }
    assert.deepEqual(install.app.accountIds(), [])
    assert.deepEqual(fs.readdirSync(`${install.dataDir}/accounts`), [])
    assert.throws(() => install.app.account(id), /not provisioned/i)
    await assert.rejects(async () => install.app.stores.account(id).summary({}), /not provisioned/i)
    assert.deepEqual(fs.readdirSync(`${install.dataDir}/accounts`), [])
    const owner = await install.signUp({ email: 'owner@example.com' })
    assert.equal((await install.fetch(`/u/${owner.accountId}.x`)).status, 404)
    install.app.control.ctx.db.run('UPDATE accounts SET deleted_at = ? WHERE id = ?', install.clock.now(), owner.accountId)
    assert.equal((await install.fetch(`/u/${owner.accountId}.x`)).status, 404)
  } finally { install.close() }
})
