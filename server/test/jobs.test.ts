import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, type Install } from './harness.ts'
import { accountRegistry } from '../account/modules.ts'
import { Budget, MAX_ATTEMPTS, runDueJobs, type JobHandler } from '../core/jobs.ts'

let install: Install
let accountId: string
before(async () => {
  install = await createInstall()
  const owner = await install.signUp({ email: 'owner@example.com' })
  accountId = owner.accountId!
})
after(() => install.close())

/** Test-only job kinds are registered straight on the shared registry. */
const calls: Record<string, number> = {}
const register = (kind: string, handler: JobHandler) => {
  accountRegistry.jobs.set(kind, async (ctx, payload, budget, job) => {
    calls[kind] = (calls[kind] ?? 0) + 1
    return handler(ctx, payload, budget, job)
  })
}
register('t.ok', async () => 'done')
register('t.fail', async () => {
  throw new Error('boom')
})
register('t.again', async (ctx, payload: { until: number }) => (ctx.now() >= payload.until ? 'done' : { again: payload.until }))
register('t.slow', async (ctx, _p, budget) => (budget.take(1) ? 'done' : { again: ctx.now() }))

const store = () => install.app.account(accountId)
const rows = () => store().ctx.db.all<{ id: string; kind: string; attempts: number; run_at: number; locked_until: number | null; last_error: string | null }>('SELECT * FROM jobs ORDER BY created_at')

test('a job enqueued in an account store runs from the alarm', async () => {
  store().ctx.jobs.enqueue('t.ok', {})
  assert.ok((store().nextWakeAt() ?? Infinity) <= install.clock.now(), 'the alarm is armed for now')
  await install.runJobs()
  assert.equal(calls['t.ok'], 1)
  assert.equal(rows().length, 0)
})

test('a failing job retries with backoff and lands in jobs_dead after the last attempt', async () => {
  const { id } = store().ctx.jobs.enqueue('t.fail', {})
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await install.runJobs()
    assert.equal(calls['t.fail'], attempt)
    const row = rows().find((r) => r.id === id)
    if (attempt < MAX_ATTEMPTS) {
      assert.ok(row, 'still queued')
      assert.equal(row.attempts, attempt)
      assert.equal(row.last_error, 'boom')
      assert.ok(row.run_at > install.clock.now(), 'scheduled in the future')
      assert.equal(row.locked_until, null, 'lease released')
      install.clock.advance(row.run_at - install.clock.now() + 1)
    } else assert.equal(row, undefined)
  }
  const dead = store().ctx.db.get<{ attempts: number; last_error: string }>('SELECT * FROM jobs_dead WHERE id = ?', id)
  assert.equal(dead?.attempts, MAX_ATTEMPTS)
  await install.runJobs()
  const alert = install.app.control.ctx.db.get<{ kind: string; account_id: string }>("SELECT * FROM admin_alerts WHERE kind = 'job_dead'")
  assert.equal(alert?.account_id, accountId)
})

test('a dedupe key keeps one queued job and frees up once it ran', async () => {
  const first = store().ctx.jobs.enqueue('t.ok', { n: 1 }, { dedupeKey: 'once' })
  const second = store().ctx.jobs.enqueue('t.ok', { n: 2 }, { dedupeKey: 'once' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.id, first.id)
  const before = calls['t.ok']
  await install.runJobs()
  assert.equal(calls['t.ok'], before + 1)
  assert.equal(store().ctx.jobs.enqueue('t.ok', {}, { dedupeKey: 'once' }).created, true)
  await install.runJobs()
})

test('a handler that asks to run again is rescheduled without counting an attempt', async () => {
  const until = install.clock.now() + 60_000
  const { id } = store().ctx.jobs.enqueue('t.again', { until })
  await install.runJobs()
  const row = rows().find((r) => r.id === id)!
  assert.equal(row.attempts, 0)
  assert.equal(row.run_at, until)
  install.clock.advance(60_000)
  await install.runJobs()
  assert.equal(rows().find((r) => r.id === id), undefined)
})

test('a claimant whose lease expired cannot finish the job for its successor', async () => {
  const { id } = store().ctx.jobs.enqueue('t.ok', {})
  const db = store().ctx.db
  db.run('UPDATE jobs SET locked_until = ?, claim_token = ? WHERE id = ?', install.clock.now() - 1, 'stale', id)
  const before = calls['t.ok']
  await install.runJobs()
  assert.equal(calls['t.ok'], before + 1, 'a new claimant took over the expired lease')
  assert.equal(db.run('DELETE FROM jobs WHERE id = ? AND claim_token = ?', id, 'stale').changes, 0, 'the stale token matches nothing')
})

test('the shared budget stops handlers and they yield until the next run', async () => {
  store().ctx.jobs.enqueue('t.slow', {})
  store().ctx.jobs.enqueue('t.slow', {})
  const ctx = store().ctx
  const ran = await runDueJobs(ctx, new Budget(install.clock.now() + 1000, 1, install.clock.now))
  assert.equal(ran, 2)
  assert.equal(rows().filter((r) => r.kind === 't.slow').length, 1, 'one job got the request, the other yielded')
  await install.runJobs()
  assert.equal(rows().filter((r) => r.kind === 't.slow').length, 0)
})

test('a due job survives a restart and runs after it', async () => {
  const runAt = install.clock.now() + 5 * 60_000
  store().ctx.jobs.enqueue('t.ok', {}, { runAt })
  install = await install.restart()
  const before = calls['t.ok']
  await install.runJobs()
  assert.equal(calls['t.ok'], before, 'not due yet')
  install.clock.advance(5 * 60_000)
  await install.runJobs()
  assert.equal(calls['t.ok'], before + 1)
})

test('the same job can be queued and run twice; an idempotent handler converges', async () => {
  const ctx = store().ctx
  const before = calls['t.ok']
  ctx.jobs.enqueue('t.ok', { same: true })
  ctx.jobs.enqueue('t.ok', { same: true })
  await install.runJobs()
  assert.equal(calls['t.ok'], before + 2)
  assert.equal(rows().length, 0)
})
