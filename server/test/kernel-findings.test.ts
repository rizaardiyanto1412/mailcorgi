import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createInstall } from './harness.ts'
import { controlRegistry } from '../control/modules.ts'

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

test('an HTTP invocation retries a failed alarm registration and queued work runs', async () => {
  const install = await createInstall()
  const store = install.app.control
  const platform = install.app.platform
  const original = platform.setAlarm
  let failed = false
  let registeredAt: number | null = null
  let ran = false
  controlRegistry.jobs.set('test.alarm-recovery', async () => { ran = true; return 'done' })
  try {
    await store.rearm()
    platform.setAlarm = async (ref, at) => {
      if (at !== null && !failed) { failed = true; throw new Error('transient alarm failure') }
      await original(ref, at)
      registeredAt = at
    }
    store.ctx.jobs.enqueue('test.alarm-recovery', {}, { runAt: install.clock.now() + 1000 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(failed, true)
    await install.fetch('/api/auth/bootstrap')
    assert.equal(registeredAt, install.clock.now() + 1000)
    install.clock.advance(1000)
    await install.tick()
    assert.equal(ran, true)
  } finally {
    platform.setAlarm = original
    controlRegistry.jobs.delete('test.alarm-recovery')
    install.close()
  }
})

test('an invocation restores an alarm that disappeared after successful registration', async () => {
  const install = await createInstall()
  let ran = false
  controlRegistry.jobs.set('test.alarm-missing', async () => { ran = true; return 'done' })
  try {
    const store = install.app.control
    store.ctx.jobs.enqueue('test.alarm-missing', {}, { runAt: install.clock.now() + 1000 })
    await store.rearm()
    const original = install.app.platform.setAlarm
    let registeredAt: number | null = null
    install.app.platform.setAlarm = async (ref, at) => { await original(ref, at); registeredAt = at }
    await original({ kind: 'control' }, null)
    await install.fetch('/api/auth/bootstrap')
    assert.equal(registeredAt, install.clock.now() + 1000)
    install.clock.advance(1000)
    await install.tick()
    assert.equal(ran, true)
  } finally {
    controlRegistry.jobs.delete('test.alarm-missing')
    install.close()
  }
})

test('overlapping alarm registrations cannot replace an earlier wake with a late one', async () => {
  const install = await createInstall()
  const store = install.app.control
  const platform = install.app.platform
  const original = platform.setAlarm
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let entered: () => void = () => {}
  const started = new Promise<void>((resolve) => { entered = resolve })
  let hold = true
  let registeredAt: number | null = null
  let ran = false
  controlRegistry.jobs.set('test.alarm-order', async () => { ran = true; return 'done' })
  try {
    await store.rearm()
    platform.setAlarm = async (ref, at) => {
      if (at !== null && hold) { hold = false; entered(); await blocked }
      await original(ref, at)
      registeredAt = at
    }
    store.ctx.jobs.enqueue('test.alarm-order', {}, { runAt: install.clock.now() + 10_000 })
    await started
    store.ctx.jobs.enqueue('test.alarm-order', {}, { runAt: install.clock.now() + 1000 })
    const request = install.fetch('/api/auth/bootstrap')
    await new Promise<void>((resolve) => setImmediate(resolve))
    release()
    await request
    await store.rearm()
    assert.equal(registeredAt, install.clock.now() + 1000)
    install.clock.advance(1000)
    await install.tick()
    assert.equal(ran, true)
  } finally {
    release()
    platform.setAlarm = original
    controlRegistry.jobs.delete('test.alarm-order')
    install.close()
  }
})
