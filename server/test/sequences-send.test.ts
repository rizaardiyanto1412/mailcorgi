/** Email sequences, the running half: activation, enrollment, the tick that sends due steps, and exits. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Budget } from '../core/jobs.ts'
import type { StoreCtx } from '../core/store.ts'
import type { EmailProvider, SendResult } from '../email/index.ts'
import { testProvider } from '../email/test.ts'
import { subscribe } from '../account/contacts/index.ts'
import { sendHooks } from '../account/sending/index.ts'
import { GRACE_MS, HOLD_MS } from '../account/sequences/index.ts'
import { tick } from '../account/sequences/tick.ts'
import { countSentInPeriod, currentPeriod } from '../account/usage/index.ts'
import { pushPolicy } from '../control/accounts/index.ts'
import { planLimits } from '../control/billing/plans.ts'
import { expectError, type Client, type Install } from './harness.ts'
import { finish, upload } from './imports-setup.ts'
import { parseHeaders, sendableInstall } from './sending-setup.ts'

const DAY = 86_400_000
const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] })
const apiHeaders = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' })
type Entry = { type: 'tag'; tagId: string } | { type: 'signup' } | { type: 'manual' }

async function setup(opts: Parameters<typeof sendableInstall>[0] = {}) {
  const base = await sendableInstall(opts)
  const tag = await base.owner.action('tags.create', { newsletterId: base.nl.id, name: 'new-signup' })
  const paid = await base.owner.action('tags.create', { newsletterId: base.nl.id, name: 'paid' })
  return { ...base, tag, paid }
}
async function draftSequence(owner: Client, newsletterId: string, entry: Entry, delays = [1, 3, 7], exit: { tagIds?: string[]; segmentId?: string } = {}, name = 'Onboarding') {
  return owner.action('sequences.create', { newsletterId, name, entry, exit, steps: delays.map((d) => ({ delayDays: d, subject: `Day ${d}`, doc: doc(`Body for day ${d}`) })) })
}
async function activeSequence(owner: Client, newsletterId: string, entry: Entry, delays = [1, 3, 7], exit: { tagIds?: string[]; segmentId?: string } = {}, name = 'Onboarding') {
  const draft = await draftSequence(owner, newsletterId, entry, delays, exit, name)
  return owner.action('sequences.activate', { newsletterId, sequenceId: draft.id })
}
const mails = (install: Install, accountId: string) => install.outbox(accountId).filter((m) => m.kind === 'campaign').map((m) => `${m.to_email}: ${m.subject}`)
const enrollmentOf = (ctx: StoreCtx, sequenceId: string, contactId: string) => {
  const row = ctx.db.get<{ status: string; source: string; enrolled_at: number; next_step_id: string | null; last_step_id: string | null; next_run_at: number | null; exit_reason: string | null; finished_at: number | null }>('SELECT status, source, enrolled_at, next_step_id, last_step_id, next_run_at, exit_reason, finished_at FROM sequence_enrollments WHERE sequence_id = ? AND contact_id = ?', sequenceId, contactId)
  return row ? { ...row } : null
}
const tickJob = (ctx: StoreCtx, newsletterId: string) => ctx.db.get<{ run_at: number; attempts: number }>('SELECT run_at, attempts FROM jobs WHERE dedupe_key = ?', `sequences.tick:${newsletterId}`)
const budget = (ctx: StoreCtx) => new Budget(ctx.now() + 60_000, 50, ctx.now)
const deliveries = (ctx: StoreCtx, campaignId: string) => ctx.db.all<{ id: number; contact_id: string; status: string; error: string | null; attempts: number }>('SELECT id, contact_id, status, error, attempts FROM deliveries WHERE campaign_id = ? ORDER BY id', campaignId).map((d) => ({ ...d }))
/** Advance the clock and run every due alarm. */
async function pass(install: Install, ms: number) {
  install.clock.advance(ms)
  await install.runJobs()
}
/** A provider wrapper around the test provider that can fail on demand. */
function fakeProvider(opts: { idempotency?: boolean; plan?: (call: number) => SendResult | 'throw' | null } = {}) {
  const calls = { n: 0 }
  sendHooks.provider = (ctx) => {
    const base = testProvider(ctx)
    const provider: EmailProvider = {
      name: 'test', capabilities: { identities: false, events: false, idempotency: opts.idempotency ?? true },
      async send(msg) {
        const planned = opts.plan?.(++calls.n) ?? null
        if (planned === 'throw') throw new Error('connection lost')
        return planned ?? base.send(msg)
      },
    }
    return provider
  }
  return calls
}

test('activation checks the sequence, and the lifecycle is draft → active ⇄ paused, with archived final', async (t) => {
  const { install, owner, nl, ctx, tag } = await setup()
  t.after(() => install.close())
  const at = (sequenceId: string) => ({ newsletterId: nl.id, sequenceId })
  const refused = async (fn: () => Promise<unknown>, status: number, code: string) => { const e = await expectError(fn); assert.deepEqual([e.status, e.code], [status, code]); return e }

  const empty = await draftSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [])
  await refused(() => owner.action('sequences.activate', at(empty.id)), 409, 'no_steps')
  const blank = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Blank', entry: { type: 'manual' }, steps: [{ delayDays: 1, subject: 'Day 1' }, { delayDays: 2 }] })
  const review = await refused(() => owner.action('sequences.activate', at(blank.id)), 400, 'review_failed')
  assert.deepEqual([(review.details as { stepId: string }).stepId, (review.details as { position: number }).position], [blank.steps[1].id, 2])
  // Steps saved before the rule existed may be out of order: activation refuses them.
  const legacy = await draftSequence(owner, nl.id, { type: 'manual' }, [1, 3])
  ctx.db.run('UPDATE sequence_steps SET delay_days = 5 WHERE id = ?', legacy.steps[0].id)
  await refused(() => owner.action('sequences.activate', at(legacy.id)), 409, 'step_delay_order')
  const segment = await owner.action('segments.create', { newsletterId: nl.id, name: 'Everyone', filter: { field: 'status', in: ['subscribed'] } })
  const bySegment = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Segment', entry: { type: 'segment', segmentId: segment.id }, steps: [{ delayDays: 1, subject: 'Day 1' }] })
  await refused(() => owner.action('sequences.activate', at(bySegment.id)), 409, 'not_supported_yet')

  const draft = await draftSequence(owner, nl.id, { type: 'tag', tagId: tag.id })
  await refused(() => owner.action('sequences.pause', at(draft.id)), 409, 'invalid_transition')
  await refused(() => owner.action('sequences.resume', at(draft.id)), 409, 'invalid_transition')
  install.app.control.ctx.db.run("INSERT OR REPLACE INTO install_settings (key, value) VALUES ('sending_enabled', 'false')")
  await refused(() => owner.action('sequences.activate', at(draft.id)), 403, 'sending_disabled')
  install.app.control.ctx.db.run("DELETE FROM install_settings WHERE key = 'sending_enabled'")
  await owner.action('newsletters.update', { newsletterId: nl.id, postalAddress: '' })
  await refused(() => owner.action('sequences.activate', at(draft.id)), 400, 'review_failed')
  await owner.action('newsletters.update', { newsletterId: nl.id, postalAddress: '1 Example Street' })
  assert.equal((await owner.action('sequences.get', at(draft.id))).status, 'draft')

  const active = await owner.action('sequences.activate', at(draft.id))
  assert.equal(active.status, 'active')
  await refused(() => owner.action('sequences.activate', at(draft.id)), 409, 'invalid_transition')
  await refused(() => owner.action('sequences.resume', at(draft.id)), 409, 'invalid_transition')
  assert.equal((await owner.action('sequences.pause', at(draft.id))).status, 'paused')
  await refused(() => owner.action('sequences.pause', at(draft.id)), 409, 'invalid_transition')
  await refused(() => owner.action('sequences.activate', at(draft.id)), 409, 'invalid_transition')
  assert.equal((await owner.action('sequences.resume', at(draft.id))).status, 'active')
  // A running sequence keeps a subject on every step and at least one step.
  const step = active.steps[0]
  await refused(() => owner.action('sequences.updateStep', { ...at(draft.id), stepId: step.id, revision: step.revision, subject: ' ' }), 400, 'review_failed')
  // The editor's save (campaigns.update) holds a step campaign to the same rule, active or paused; a draft may still be emptied.
  await refused(() => owner.action('campaigns.update', { campaignId: step.campaignId, revision: step.revision, subject: '' }), 400, 'review_failed')
  await owner.action('sequences.pause', at(draft.id))
  await refused(() => owner.action('campaigns.update', { campaignId: step.campaignId, revision: step.revision, subject: '  ' }), 400, 'review_failed')
  await owner.action('sequences.resume', at(draft.id))
  assert.equal((await owner.action('campaigns.update', { campaignId: step.campaignId, revision: step.revision, previewText: 'Kept' })).subject, 'Day 1')
  const loose = await draftSequence(owner, nl.id, { type: 'manual' }, [1], {}, 'Loose')
  assert.equal((await owner.action('campaigns.update', { campaignId: loose.steps[0].campaignId, revision: loose.steps[0].revision, subject: '' })).subject, '')
  const single = await activeSequence(owner, nl.id, { type: 'manual' }, [1], {}, 'Single')
  await refused(() => owner.action('sequences.deleteStep', { ...at(single.id), stepId: single.steps[0].id }), 409, 'last_step')

  // Archiving ends every enrollment still running; nothing brings the sequence back.
  const contact = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com', tags: [tag.id] })).contact
  const held = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'held@example.com', tags: [tag.id] })).contact
  await owner.action('sequences.pauseEnrollment', { ...at(draft.id), contactId: held.id })
  const archived = await owner.action('sequences.archive', at(draft.id))
  assert.deepEqual([archived.status, archived.enrollments], ['archived', { total: 2, active: 0, paused: 0, completed: 0, exited: 2 }])
  assert.deepEqual([enrollmentOf(ctx, draft.id, contact.id)!.exit_reason, enrollmentOf(ctx, draft.id, held.id)!.exit_reason], ['archived', 'archived'])
  for (const name of ['sequences.activate', 'sequences.pause', 'sequences.resume'] as const) await refused(() => owner.action(name, at(draft.id)), 409, 'sequence_archived')
  await refused(() => owner.action('sequences.resumeEnrollment', { ...at(draft.id), contactId: held.id }), 409, 'sequence_archived')
  await refused(() => owner.action('sequences.enroll', { ...at(draft.id), contactId: contact.id }), 409, 'sequence_not_active')
  await pass(install, 8 * DAY)
  assert.deepEqual(mails(install, owner.accountId!), [])
})

test('steps go out at exactly enrolled_at + N days, in order, each contact on their own clock', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup()
  t.after(() => install.close())
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id })
  const start = install.clock.now()
  const ada = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', tags: [tag.id] })).contact
  assert.deepEqual(enrollmentOf(ctx, sequence.id, ada.id), { status: 'active', source: 'manual', enrolled_at: start, next_step_id: sequence.steps[0].id, last_step_id: null, next_run_at: start + DAY, exit_reason: null, finished_at: null })
  assert.equal(tickJob(ctx, nl.id)!.run_at, start + DAY)
  await install.runJobs()
  assert.deepEqual(mails(install, accountId), [], 'nothing is due at enrollment: the first step is at least a day away')
  // Bob enters half a day later and runs on his own clock.
  await pass(install, DAY / 2)
  const bob = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'bob@example.com', tags: [tag.id] })).contact
  assert.equal(tickJob(ctx, nl.id)!.run_at, start + DAY, 'a later enrollment does not push the tick back')
  await pass(install, DAY / 2 - 1)
  assert.deepEqual(mails(install, accountId), [], 'one millisecond early is too early')
  await pass(install, 1)
  assert.deepEqual(mails(install, accountId), ['ada@example.com: Day 1'])
  assert.deepEqual([enrollmentOf(ctx, sequence.id, ada.id)!.next_step_id, enrollmentOf(ctx, sequence.id, ada.id)!.last_step_id, enrollmentOf(ctx, sequence.id, ada.id)!.next_run_at], [sequence.steps[1].id, sequence.steps[0].id, start + 3 * DAY])
  assert.equal(tickJob(ctx, nl.id)!.run_at, start + DAY + DAY / 2, 'the tick re-arms to the next enrollment due')
  await pass(install, DAY / 2)
  assert.deepEqual(mails(install, accountId), ['ada@example.com: Day 1', 'bob@example.com: Day 1'])
  await pass(install, DAY + DAY / 2 - 1)
  assert.equal(mails(install, accountId).length, 2)
  await pass(install, 1)
  assert.equal(mails(install, accountId).at(-1), 'ada@example.com: Day 3')
  await pass(install, 4 * DAY)
  assert.deepEqual(mails(install, accountId), ['ada@example.com: Day 1', 'bob@example.com: Day 1', 'ada@example.com: Day 3', 'bob@example.com: Day 3', 'ada@example.com: Day 7'])
  const done = enrollmentOf(ctx, sequence.id, ada.id)!
  assert.deepEqual([done.status, done.next_step_id, done.next_run_at, done.last_step_id, done.finished_at], ['completed', null, null, sequence.steps[2].id, start + 7 * DAY])
  await pass(install, DAY)
  assert.equal(mails(install, accountId).at(-1), 'bob@example.com: Day 7')
  assert.equal(enrollmentOf(ctx, sequence.id, bob.id)!.status, 'completed')
  assert.equal(tickJob(ctx, nl.id), undefined, 'with nobody waiting the tick job ends')
  await pass(install, 3 * DAY)
  assert.equal(mails(install, accountId).length, 6)
  // One delivery per step and contact; the step campaigns stay hidden drafts and carry the stats.
  for (const step of sequence.steps) {
    assert.deepEqual(deliveries(ctx, step.campaignId).map((d) => [d.contact_id, d.status]), [[ada.id, 'sent'], [bob.id, 'sent']])
    assert.equal((await owner.action('campaigns.get', { campaignId: step.campaignId })).status, 'draft')
    assert.equal((await owner.action('stats.report', { campaignId: step.campaignId })).counts.sent, 2)
    assert.equal((await owner.action('stats.recipients', { campaignId: step.campaignId, status: 'all' } as never) as { items: unknown[] }).items.length, 2)
  }
  const stats = await owner.action('sequences.stats', { newsletterId: nl.id, sequenceId: sequence.id })
  assert.deepEqual(stats.enrollments, { total: 2, active: 0, paused: 0, completed: 2, exited: 0 })
  assert.deepEqual(stats.steps.map((s) => [s.position, s.delayDays, s.subject, s.waiting, s.sent, s.campaignId]), sequence.steps.map((s) => [s.position, s.delayDays, s.subject, 0, 2, s.campaignId]))
  // Sequence emails count as sent, never toward the ignored-issues streak that hygiene acts on.
  assert.deepEqual({ ...ctx.db.get<object>('SELECT sent_count, ignored_streak, strict_ignored_streak FROM contacts WHERE id = ?', ada.id) }, { sent_count: 3, ignored_streak: 0, strict_ignored_streak: 0 })
  assert.equal((await owner.action('segments.count', { newsletterId: nl.id, filter: { field: 'engagement', op: 'ignoredLast', issues: 1 } })).count, 0)
  assert.equal((await owner.action('campaigns.list', { newsletterId: nl.id })).total, 0)
})

test('a step is sent once: overlapping ticks, a retried job, a crash mid-send and provider failures never send it twice', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup()
  t.after(() => { sendHooks.provider = null; install.close() })
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1, 2, 3, 4, 5, 6])
  const [s1, s2, s3, s4, s5, s6] = sequence.steps
  const contact = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com', tags: [tag.id] })).contact
  const state = () => enrollmentOf(ctx, sequence.id, contact.id)!
  const start = install.clock.now()

  // Two alarms overlap on the same due step.
  install.clock.advance(DAY)
  await Promise.all([tick(ctx, nl.id, budget(ctx)), tick(ctx, nl.id, budget(ctx)), tick(ctx, nl.id, budget(ctx))])
  assert.deepEqual(mails(install, accountId), ['reader@example.com: Day 1'])
  await install.runJobs()
  assert.deepEqual([state().next_step_id, state().next_run_at], [s2.id, start + 2 * DAY])
  // The job runs again after the email left but before the enrollment moved on (a crash, a lost lease).
  ctx.db.run('UPDATE sequence_enrollments SET next_step_id = ?, last_step_id = NULL, next_run_at = ? WHERE sequence_id = ?', s1.id, ctx.now(), sequence.id)
  await tick(ctx, nl.id, budget(ctx))
  await tick(ctx, nl.id, budget(ctx))
  assert.deepEqual(mails(install, accountId), ['reader@example.com: Day 1'])
  assert.deepEqual([state().next_step_id, state().last_step_id, state().next_run_at], [s2.id, s1.id, start + 2 * DAY])
  assert.equal(ctx.db.get<{ n: number }>('SELECT emails_sent AS n FROM usage WHERE period = ?', currentPeriod(ctx.now()))!.n, 1)
  assert.throws(() => ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at) VALUES (?, ?, 'reader@example.com', 'queued', 1)", s1.campaignId, contact.id), /UNIQUE/)

  // A crash leaves step 2 in `sending`. The provider deduplicates, so after ten minutes it is retried with the same key, once.
  install.clock.advance(DAY)
  ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, attempt_token, attempt_at, attempts, queued_at) VALUES (?, ?, 'reader@example.com', 'sending', 'lost', ?, 1, ?)", s2.campaignId, contact.id, ctx.now(), ctx.now())
  await install.runJobs()
  assert.equal(mails(install, accountId).length, 1)
  assert.deepEqual([state().next_step_id, state().next_run_at], [s2.id, ctx.now() + 10 * 60_000])
  await pass(install, 10 * 60_000)
  assert.deepEqual(mails(install, accountId), ['reader@example.com: Day 1', 'reader@example.com: Day 2'])
  assert.deepEqual(deliveries(ctx, s2.campaignId).map((d) => [d.status, d.attempts]), [['sent', 2]])
  assert.equal(state().next_step_id, s3.id)

  // Without provider idempotency the outcome stays unknown: never resent, and the enrollment moves on.
  fakeProvider({ idempotency: false })
  install.clock.advance(start + 3 * DAY - ctx.now())
  ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, attempt_token, attempt_at, attempts, queued_at) VALUES (?, ?, 'reader@example.com', 'sending', 'lost', ?, 1, ?)", s3.campaignId, contact.id, ctx.now() - 10 * 60_000, ctx.now())
  const before = mails(install, accountId).length
  await install.runJobs()
  assert.equal(mails(install, accountId).length, before)
  assert.deepEqual(deliveries(ctx, s3.campaignId).map((d) => d.status), ['unknown'])
  assert.equal(state().next_step_id, s4.id)
  // An unknown outcome from a send that throws, same provider: unknown, not retried.
  fakeProvider({ idempotency: false, plan: () => 'throw' })
  await pass(install, start + 4 * DAY - ctx.now())
  assert.deepEqual(deliveries(ctx, s4.campaignId).map((d) => d.status), ['unknown'])
  assert.equal(state().next_step_id, s5.id)

  // A temporary refusal waits and retries; the third one in a row fails the delivery and the enrollment moves on.
  fakeProvider({ plan: (call) => (call <= 2 ? { ok: false, kind: 'temporary', message: 'try later' } : null) })
  await pass(install, start + 5 * DAY - ctx.now())
  assert.deepEqual(deliveries(ctx, s5.campaignId).map((d) => [d.status, d.attempts, d.error]), [['queued', 1, 'try later']])
  assert.ok(state().next_run_at! > ctx.now() && state().next_step_id === s5.id, 'the enrollment waits for the retry')
  for (let i = 0; i < 10 && state().next_step_id === s5.id; i++) await pass(install, 60_000)
  assert.deepEqual(deliveries(ctx, s5.campaignId).map((d) => [d.status, d.attempts]), [['sent', 3]])
  assert.equal(mails(install, accountId).filter((m) => m.endsWith('Day 5')).length, 1)
  // A permanent refusal fails the delivery at once; the sequence still completes.
  fakeProvider({ plan: () => ({ ok: false, kind: 'permanent', message: 'refused' }) })
  await pass(install, start + 6 * DAY - ctx.now())
  assert.deepEqual(deliveries(ctx, s6.campaignId).map((d) => [d.status, d.error]), [['failed', 'refused']])
  assert.deepEqual([state().status, state().last_step_id], ['completed', s6.id])
  const stats = await owner.action('sequences.stats', { newsletterId: nl.id, sequenceId: sequence.id })
  assert.deepEqual(stats.steps.map((s) => [s.sent, s.failed]), [[1, 0], [1, 0], [0, 0], [0, 0], [1, 0], [0, 1]])
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs_dead')!.n, 0)
})

test('temporary refusals are bounded: after three the delivery fails, and a throttle resumes without spending an attempt', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup()
  t.after(() => { sendHooks.provider = null; install.close() })
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1, 2])
  const contact = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com', tags: [tag.id] })).contact
  const state = () => enrollmentOf(ctx, sequence.id, contact.id)!
  const calls = fakeProvider({ plan: () => ({ ok: false, kind: 'temporary', message: 'try later' }) })
  await pass(install, DAY)
  for (let i = 0; i < 20 && state().next_step_id === sequence.steps[0].id; i++) await pass(install, 60_000)
  assert.equal(calls.n, 3)
  assert.deepEqual(deliveries(ctx, sequence.steps[0].campaignId).map((d) => [d.status, d.attempts]), [['failed', 3]])
  assert.equal(state().next_step_id, sequence.steps[1].id)
  const throttled = fakeProvider({ plan: (call) => (call === 1 ? { ok: false, kind: 'throttled', message: 'slow down', retryAfterMs: 5000 } : null) })
  await pass(install, DAY - (ctx.now() - state().enrolled_at - DAY))
  assert.deepEqual([throttled.n, deliveries(ctx, sequence.steps[1].campaignId).map((d) => [d.status, d.attempts])], [1, [['queued', 0]]])
  for (let i = 0; i < 20 && state().status === 'active'; i++) await pass(install, 1000)
  assert.deepEqual(mails(install, accountId), ['reader@example.com: Day 2'])
  assert.equal(state().status, 'completed')
})

test('due steps over the install hourly cap wait for the window instead of failing, and each goes out once', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup()
  t.after(() => install.close())
  const HOUR = 3_600_000
  await owner.action('install.settings.set', { values: { send_rate_per_hour: '3' } })
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1])
  const campaignId = sequence.steps[0].campaignId
  for (let i = 0; i < 7; i++) await owner.action('contacts.create', { newsletterId: nl.id, email: `reader${i}@example.com`, tags: [tag.id] })
  const active = () => ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ? AND status = 'active'", sequence.id)!.n
  const statuses = () => deliveries(ctx, campaignId).map((d) => [d.status, d.attempts])
  const sentCount = () => mails(install, accountId).length

  await pass(install, DAY)
  const first = install.clock.now()
  assert.equal(sentCount(), 3, 'only cap-many go out in the hour')
  assert.equal(active(), 4, 'the rest keep waiting for the same step')
  assert.deepEqual(statuses().filter(([status]) => status !== 'sent'), [['queued', 0], ['queued', 0], ['queued', 0], ['queued', 0]], 'waiting for the cap spends no attempt')
  const wake = tickJob(ctx, nl.id)!.run_at
  assert.ok(wake >= first + HOUR && wake <= first + HOUR + 60_000, 'the tick sleeps until the window has room')
  // Waking early (a retried job, an overlapping run) sends nothing more inside the hour.
  await pass(install, 30 * 60_000)
  await tick(ctx, nl.id, budget(ctx))
  install.clock.set(wake - 1)
  await install.runJobs()
  assert.equal(sentCount(), 3)

  install.clock.set(wake)
  await install.runJobs()
  assert.equal(sentCount(), 6)
  const second = tickJob(ctx, nl.id)!.run_at
  assert.ok(second >= wake + HOUR - 60_000 && second <= wake + HOUR + 60_000)
  install.clock.set(second - 1)
  await install.runJobs()
  assert.equal(sentCount(), 6)
  install.clock.set(second)
  await install.runJobs()

  const sent = mails(install, accountId)
  assert.deepEqual([...sent].sort(), Array.from({ length: 7 }, (_, i) => `reader${i}@example.com: Day 1`), 'everyone gets the step exactly once')
  assert.deepEqual(statuses(), Array.from({ length: 7 }, () => ['sent', 1]))
  assert.equal(active(), 0)
  assert.equal(tickJob(ctx, nl.id), undefined, 'nothing is left to wait for')
  await pass(install, 2 * HOUR)
  assert.equal(sentCount(), 7)
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs_dead')!.n, 0)
})

test('exit rules: an exit tag, unsubscribing by link or by hand, suppression, deletion, a bounce and a complaint stop further steps', async (t) => {
  const { install, owner, nl, ctx, accountId, tag, paid } = await setup()
  t.after(() => install.close())
  const vip = await owner.action('tags.create', { newsletterId: nl.id, name: 'vip' })
  const vips = await owner.action('segments.create', { newsletterId: nl.id, name: 'VIPs', filter: { field: 'tag', id: vip.id } })
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1, 3], { tagIds: [paid.id], segmentId: vips.id })
  const add = async (name: string, tags = [tag.id]) => (await owner.action('contacts.create', { newsletterId: nl.id, email: `${name}@example.com`, tags })).contact
  const names = ['paid', 'link', 'manual', 'suppressed', 'deleted', 'bounced', 'complained', 'vip', 'stays', 'taken']
  const c: Record<string, Awaited<ReturnType<typeof add>>> = {}
  for (const name of names) c[name] = await add(name)
  // A contact who already holds an exit tag never enters.
  const already = await add('already', [tag.id, paid.id])
  assert.equal(enrollmentOf(ctx, sequence.id, already.id), null)
  await pass(install, DAY)
  assert.equal(mails(install, accountId).length, names.length)
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const first = sequence.steps[0].campaignId
  const deliveryOf = (contactId: string) => deliveries(ctx, first).find((d) => d.contact_id === contactId)!.id

  await owner.action('contacts.update', { newsletterId: nl.id, contactId: c.paid.id, addTagIds: [paid.id] })
  const mail = install.outbox(accountId).find((m) => m.to_email === 'link@example.com')!
  const unsubscribe = parseHeaders(mail.headers)['List-Unsubscribe'].match(/<(http[^>]+)>/)![1]
  assert.equal((await install.fetch(unsubscribe, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status, 200)
  await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: c.manual.id })
  await owner.action('suppressions.add', { accountId, email: 'suppressed@example.com' })
  await owner.action('contacts.delete', { newsletterId: nl.id, contactId: c.deleted.id })
  const event = (id: string, type: 'bounce' | 'complaint', contactId: string, email: string) => ({ id, type, ...(type === 'bounce' ? { bounce: { permanent: true, nonexistent: false, reason: 'No such user' } } : {}), accountId, deliveryId: String(deliveryOf(contactId)), messageId: '', recipient: email, occurredAt: ctx.now() })
  await install.app.stores.account(accountId).ingestProviderEvents({ events: [event('evt_bounce', 'bounce', c.bounced.id, 'bounced@example.com'), event('evt_complaint', 'complaint', c.complained.id, 'complained@example.com')] })
  // The segment rule is read right before a step is sent.
  await owner.action('contacts.update', { newsletterId: nl.id, contactId: c.vip.id, addTagIds: [vip.id] })
  assert.equal(enrollmentOf(ctx, sequence.id, c.vip.id)!.status, 'active')
  const left = await owner.action('sequences.exit', { ...at, contactId: c.taken.id, reason: 'asked by email' })
  assert.deepEqual([left.status, left.exitReason, left.nextRunAt], ['exited', 'manual: asked by email', null])

  const reasons = () => Object.fromEntries(names.map((name) => [name, enrollmentOf(ctx, sequence.id, c[name].id)?.exit_reason ?? null]))
  assert.deepEqual(reasons(), { paid: 'tag', link: 'unsubscribed', manual: 'unsubscribed', suppressed: 'unsubscribed', deleted: null, bounced: 'bounced', complained: 'complained', vip: null, stays: null, taken: 'manual: asked by email' })
  assert.equal(enrollmentOf(ctx, sequence.id, c.deleted.id), null, 'a deleted contact takes their enrollments with them')
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sequence_enrollments WHERE next_run_at IS NOT NULL')!.n, 2, 'an enrollment that ended waits for nothing')
  assert.equal((await owner.action('sequences.stats', at)).steps[0].unsubscribes, 1, 'the link names the step campaign, so its report counts the unsubscribe')

  await pass(install, 2 * DAY)
  assert.deepEqual(mails(install, accountId).slice(names.length), ['stays@example.com: Day 3'])
  assert.deepEqual([enrollmentOf(ctx, sequence.id, c.vip.id)!.status, enrollmentOf(ctx, sequence.id, c.vip.id)!.exit_reason], ['exited', 'segment'])
  const sequenceNow = await owner.action('sequences.get', at)
  assert.deepEqual(sequenceNow.enrollments, { total: 9, active: 0, paused: 0, completed: 1, exited: 8 })
  // Out is out: gaining the entry tag again, or asking by hand, does not bring anyone back.
  await owner.action('contacts.update', { newsletterId: nl.id, contactId: c.paid.id, removeTagIds: [tag.id, paid.id] })
  await owner.action('contacts.update', { newsletterId: nl.id, contactId: c.paid.id, addTagIds: [tag.id] })
  assert.equal(enrollmentOf(ctx, sequence.id, c.paid.id)!.status, 'exited')
  assert.equal((await expectError(() => owner.action('sequences.enroll', { ...at, contactId: c.paid.id }))).code, 'already_enrolled')
  assert.equal((await expectError(() => owner.action('sequences.exit', { ...at, contactId: c.paid.id }))).code, 'invalid_transition')
  await pass(install, 10 * DAY)
  assert.equal(mails(install, accountId).length, names.length + 1)
})

test('pausing and resuming a sequence or one enrollment, and the catch-up rule: only the latest overdue step is sent', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup()
  t.after(() => install.close())
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id })
  const [s1, s2, s3] = sequence.steps
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const start = install.clock.now()
  const ada = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', tags: [tag.id] })).contact
  const bob = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'bob@example.com', tags: [tag.id] })).contact

  // One enrollment paused: nothing for Bob at day 1, and the list shows where he stands.
  const paused = await owner.action('sequences.pauseEnrollment', { ...at, contactId: bob.id })
  assert.deepEqual([paused.status, paused.nextRunAt, paused.nextStep, paused.pausedAt], ['paused', null, { id: s1.id, position: 1, delayDays: 1 }, start])
  assert.equal((await expectError(() => owner.action('sequences.pauseEnrollment', { ...at, contactId: bob.id }))).code, 'invalid_transition')
  assert.equal((await expectError(() => owner.action('sequences.resumeEnrollment', { ...at, contactId: ada.id }))).code, 'invalid_transition')
  assert.deepEqual((await owner.action('sequences.get', at)).enrollments, { total: 2, active: 1, paused: 1, completed: 0, exited: 0 })
  await pass(install, DAY)
  assert.deepEqual(mails(install, accountId), ['ada@example.com: Day 1'])
  // Resumed twelve hours late: inside the grace window, so Day 1 still goes out, now.
  await pass(install, DAY / 2)
  assert.ok(DAY / 2 < GRACE_MS)
  const resumed = await owner.action('sequences.resumeEnrollment', { ...at, contactId: bob.id })
  assert.deepEqual([resumed.status, resumed.nextRunAt, resumed.pausedAt], ['active', start + DAY, null])
  await install.runJobs()
  assert.deepEqual(mails(install, accountId), ['ada@example.com: Day 1', 'bob@example.com: Day 1'])

  // The sequence paused over days 3 and 7: nobody enters, nothing is sent.
  await owner.action('sequences.pause', at)
  const late = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'late@example.com', tags: [tag.id] })).contact
  await pass(install, 6 * DAY)
  assert.equal(mails(install, accountId).length, 2)
  assert.equal(install.clock.now(), start + 7 * DAY + DAY / 2)
  // Bob is also paused on his own; resuming the sequence does not touch him.
  await owner.action('sequences.pauseEnrollment', { ...at, contactId: bob.id })
  await owner.action('sequences.resume', at)
  await install.runJobs()
  // Ada: Day 3 is four and a half days late and Day 7 half a day late. Only the latest goes out; Day 3 is recorded as skipped.
  assert.deepEqual(mails(install, accountId).slice(2), ['ada@example.com: Day 7'])
  assert.deepEqual(deliveries(ctx, s2.campaignId).filter((d) => d.contact_id === ada.id).map((d) => [d.status, d.error]), [['skipped', 'Skipped: overdue when the sequence caught up.']])
  assert.deepEqual([enrollmentOf(ctx, sequence.id, ada.id)!.status, enrollmentOf(ctx, sequence.id, ada.id)!.last_step_id], ['completed', s3.id])
  assert.equal(enrollmentOf(ctx, sequence.id, late.id), null, 'a tag added during the pause enrolls nobody, then or later')
  // Bob resumes a day later: Day 3 and Day 7 are both overdue by a day or more, so one email, the latest.
  await pass(install, DAY)
  await owner.action('sequences.resumeEnrollment', { ...at, contactId: bob.id })
  await install.runJobs()
  assert.deepEqual(mails(install, accountId).slice(3), ['bob@example.com: Day 7'])
  assert.equal(enrollmentOf(ctx, sequence.id, bob.id)!.status, 'completed')
  const stats = await owner.action('sequences.stats', at)
  assert.deepEqual(stats.steps.map((s) => [s.sent, s.skipped]), [[2, 0], [0, 2], [2, 0]])
  await pass(install, 3 * DAY)
  assert.equal(mails(install, accountId).length, 4)

  // A single overdue step is itself the latest: it is sent, late, and nothing is skipped.
  const short = await activeSequence(owner, nl.id, { type: 'manual' }, [1, 9], {}, 'Short')
  const cara = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'cara@example.com' })).contact
  const entered = await owner.action('sequences.enroll', { newsletterId: nl.id, sequenceId: short.id, contactId: cara.id })
  assert.deepEqual([entered.status, entered.source, entered.nextRunAt, entered.email], ['active', 'manual', ctx.now() + DAY, 'cara@example.com'])
  await owner.action('sequences.pause', { newsletterId: nl.id, sequenceId: short.id })
  await pass(install, 4 * DAY)
  await owner.action('sequences.resume', { newsletterId: nl.id, sequenceId: short.id })
  await install.runJobs()
  assert.equal(mails(install, accountId).at(-1), 'cara@example.com: Day 1')
  assert.deepEqual(deliveries(ctx, short.steps[1].campaignId), [])
  assert.equal(enrollmentOf(ctx, short.id, cara.id)!.next_step_id, short.steps[1].id)
})

test('in cloud mode the tick respects the monthly email limit and sends again in the next period, or as soon as the plan is raised', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup({ cloud: true })
  t.after(() => install.close())
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1])
  const campaignId = sequence.steps[0].campaignId
  const first = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'first@example.com', tags: [tag.id] })).contact
  const second = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'second@example.com', tags: [tag.id] })).contact
  // The control store's plan (free) sets the allowance takeSendPermits reserves from: leave one email of this month.
  const control = install.app.control.ctx
  const max = planLimits('free').maxEmailsPerMonth!
  install.clock.advance(DAY)
  const period = new Date(install.clock.now()).toISOString().slice(0, 7)
  control.db.run('INSERT INTO usage_snapshots (account_id, period, contacts, emails_sent, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(account_id, period) DO UPDATE SET emails_sent = excluded.emails_sent', accountId, period, max - 1, install.clock.now())
  await install.runJobs()
  await pass(install, 60_000)
  assert.deepEqual(mails(install, accountId), ['first@example.com: Day 1'], 'only the email the allowance still covers goes out')
  assert.equal(enrollmentOf(ctx, sequence.id, first.id)!.status, 'completed')
  // The reservation is refused: no send, no failure, the contact keeps waiting for the same step.
  const waiting = enrollmentOf(ctx, sequence.id, second.id)!
  assert.deepEqual([waiting.status, waiting.next_step_id, waiting.last_step_id], ['active', sequence.steps[0].id, null])
  assert.deepEqual(deliveries(ctx, campaignId).map((d) => [d.contact_id, d.status, d.attempts]), [[first.id, 'sent', 1], [second.id, 'queued', 0]])
  assert.equal((await install.app.stores.control.takeSendPermits({ accountId, want: 1 })).granted, 0)
  const now = new Date(install.clock.now())
  const nextPeriod = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  const held = tickJob(ctx, nl.id)!
  assert.deepEqual([held.attempts, held.run_at], [0, nextPeriod], 'the tick sleeps until the allowance renews')
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs_dead')!.n, 0)
  await pass(install, nextPeriod - install.clock.now() - 1000)
  assert.equal(mails(install, accountId).length, 1)
  // A new period has a fresh allowance: the waiting step goes out, late.
  await pass(install, 1000)
  await pass(install, 60_000)
  assert.deepEqual(mails(install, accountId), ['first@example.com: Day 1', 'second@example.com: Day 1'])
  assert.equal(enrollmentOf(ctx, sequence.id, second.id)!.status, 'completed')
  assert.deepEqual(deliveries(ctx, campaignId).map((d) => d.status), ['sent', 'sent'])

  // The limit is reached again; this time the plan is raised, and the policy push wakes the sleeping tick.
  const third = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'third@example.com', tags: [tag.id] })).contact
  install.clock.advance(DAY)
  control.db.run('INSERT INTO usage_snapshots (account_id, period, contacts, emails_sent, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(account_id, period) DO UPDATE SET emails_sent = excluded.emails_sent', accountId, currentPeriod(install.clock.now()), max, install.clock.now())
  await install.runJobs()
  await pass(install, 60_000)
  assert.equal(mails(install, accountId).length, 2, 'the allowance is used up')
  const again = new Date(install.clock.now())
  const asleep = tickJob(ctx, nl.id)!
  assert.equal(asleep.run_at, Date.UTC(again.getUTCFullYear(), again.getUTCMonth() + 1, 1), 'the tick sleeps until next month')
  assert.ok(planLimits('pro').maxEmailsPerMonth! > max)
  // The test setup wrote the store's policy directly at version 1000; the control row catches up so its push is newer.
  control.db.run('UPDATE accounts SET policy_version = 1000 WHERE id = ?', accountId)
  pushPolicy(control, accountId, { plan: 'pro' })
  await install.runJobs()
  await pass(install, 60_000)
  assert.deepEqual(mails(install, accountId), ['first@example.com: Day 1', 'second@example.com: Day 1', 'third@example.com: Day 1'], 'the waiting step goes out in the same month')
  assert.equal(enrollmentOf(ctx, sequence.id, third.id)!.status, 'completed')
  assert.ok(install.clock.now() < asleep.run_at, 'without waiting for the next period')
})

test('nothing is sent while the install has sending switched off or the account is blocked, and it resumes afterwards', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup({ cloud: true })
  t.after(() => install.close())
  const sequence = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1, 2])
  const contact = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com', tags: [tag.id] })).contact
  const control = install.app.control.ctx
  control.db.run("INSERT OR REPLACE INTO install_settings (key, value) VALUES ('sending_enabled', 'false')")
  await pass(install, DAY)
  await pass(install, 60_000)
  assert.deepEqual(mails(install, accountId), [])
  const held = tickJob(ctx, nl.id)!
  assert.deepEqual([held.attempts, held.run_at > ctx.now(), held.run_at <= ctx.now() + HOLD_MS], [0, true, true], 'the tick sleeps instead of failing')
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs_dead')!.n, 0)
  assert.equal(enrollmentOf(ctx, sequence.id, contact.id)!.status, 'active')
  assert.deepEqual(deliveries(ctx, sequence.steps[0].campaignId), [])
  control.db.run("DELETE FROM install_settings WHERE key = 'sending_enabled'")
  await pass(install, HOLD_MS)
  assert.deepEqual(mails(install, accountId), ['reader@example.com: Day 1'])

  // Blocked account: the same hold. Unblocked three days late, the one overdue step still goes out.
  const stores = install.app.stores.account(accountId)
  const policy = (version: number, status: 'active' | 'blocked') => ({ version, status, plan: 'scale', limits: { maxContacts: null, maxEmailsPerMonth: null, maxNewsletters: null, maxTeamPerNewsletter: null } })
  await stores.applyPolicy(policy(2001, 'blocked'))
  await pass(install, 4 * DAY)
  assert.equal(mails(install, accountId).length, 1)
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs_dead')!.n, 0)
  assert.equal((await expectError(() => owner.action('sequences.pause', { newsletterId: nl.id, sequenceId: sequence.id }).then(() => owner.action('sequences.resume', { newsletterId: nl.id, sequenceId: sequence.id })))).code, 'account_blocked')
  await stores.applyPolicy(policy(2002, 'active'))
  await owner.action('sequences.resume', { newsletterId: nl.id, sequenceId: sequence.id })
  await install.runJobs()
  assert.deepEqual(mails(install, accountId), ['reader@example.com: Day 1', 'reader@example.com: Day 2'])
  assert.equal(enrollmentOf(ctx, sequence.id, contact.id)!.status, 'completed')
  // An archived newsletter sends nothing either.
  const second = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'second@example.com', tags: [tag.id] })).contact
  await owner.action('newsletters.create', { name: 'Spare' })
  await owner.action('newsletters.archive', { newsletterId: nl.id })
  await pass(install, 3 * DAY)
  assert.equal(mails(install, accountId).length, 2)
  assert.equal(enrollmentOf(ctx, sequence.id, second.id)!.status, 'active')
})

for (const cloud of [false, true]) test(`an app tags a new signup through the API and the sequence email goes out a day later (${cloud ? 'cloud' : 'self-hosted'})`, async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup({ cloud })
  t.after(() => install.close())
  const key = await owner.action('apikeys.create', { name: 'App', access: 'full' })
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await install.fetch(`/api/v1${path}`, { method, headers: apiHeaders(key.secret), body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const mcp = async (name: string, args: unknown) => (await (await install.fetch('/mcp', { method: 'POST', headers: { ...apiHeaders(key.secret), accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result

  // The whole workflow with a key: create, activate, tag a contact.
  const created = await api('POST', `/newsletters/${nl.id}/sequences`, { name: 'App onboarding', entry: { type: 'tag', tagId: tag.id }, steps: [{ delayDays: 1, subject: 'Welcome aboard', doc: doc('Glad you are here.') }, { delayDays: 3, subject: 'How is it going?' }] })
  assert.equal(created.status, 200)
  const sequenceId: string = created.data.id
  // Tagged before activation: no backfill.
  const early = await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'early@example.com', tags: [tag.id] })
  const activated = await api('POST', `/newsletters/${nl.id}/sequences/${sequenceId}/activate`)
  assert.deepEqual([activated.status, activated.data.status, activated.data.enrollments.total], [200, 'active', 0])
  const start = install.clock.now()
  const signup = await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'user@example.com', name: 'New User', tags: [tag.id], source: 'app' })
  assert.deepEqual([signup.status, signup.data.outcome], [200, 'subscribed'])
  const contactId: string = signup.data.contact.id
  assert.deepEqual(enrollmentOf(ctx, sequenceId, contactId), { status: 'active', source: 'api', enrolled_at: start, next_step_id: created.data.steps[0].id, last_step_id: null, next_run_at: start + DAY, exit_reason: null, finished_at: null })
  // The same call again, as an app retrying or re-syncing would: still one enrollment.
  const again = await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'user@example.com', tags: [tag.id] })
  assert.equal(again.data.outcome, 'exists')
  // Through MCP the same tool enrolls too; an existing contact who newly gains the tag enters like a new one.
  const viaMcp = await mcp('contacts_create', { newsletterId: nl.id, email: 'mcp@example.com', tags: [tag.id] })
  assert.ok(!viaMcp.isError)
  const existing = await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'existing@example.com' })
  assert.equal(enrollmentOf(ctx, sequenceId, existing.data.contact.id), null)
  await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'existing@example.com', tags: [tag.id] })
  const rows = ctx.db.all<{ email: string; source: string }>('SELECT c.email, e.source FROM sequence_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.sequence_id = ? ORDER BY c.email', sequenceId).map((r) => ({ ...r }))
  assert.deepEqual(rows, [{ email: 'existing@example.com', source: 'api' }, { email: 'mcp@example.com', source: 'mcp' }, { email: 'user@example.com', source: 'api' }])
  assert.equal(enrollmentOf(ctx, sequenceId, early.data.contact.id), null, 'activation does not enroll contacts who already had the tag')

  // Monitoring: the list, the contact and the stats.
  const listed = await api('GET', `/newsletters/${nl.id}/sequences/${sequenceId}/enrollments?status=active`)
  assert.deepEqual([listed.status, listed.data.enrollments.length, listed.data.nextCursor], [200, 3, null])
  const mine = listed.data.enrollments.find((e: { email: string }) => e.email === 'user@example.com')
  assert.deepEqual([mine.name, mine.status, mine.enrolledAt, mine.nextRunAt, mine.nextStep.position, mine.lastStep, mine.exitReason], ['New User', 'active', start, start + DAY, 1, null, null])
  const got = await api('GET', `/newsletters/${nl.id}/contacts/${contactId}`)
  assert.deepEqual(got.data.enrollments, [{ sequenceId, name: 'App onboarding', sequenceStatus: 'active', status: 'active', enrolledAt: start, nextRunAt: start + DAY, exitReason: null }])

  // A day later the alarm runs the tick: one email per contact, tracked like a campaign email.
  await pass(install, DAY - 1)
  assert.deepEqual(mails(install, accountId), [])
  await pass(install, 1)
  const outbox = install.outbox(accountId).filter((m) => m.kind === 'campaign')
  assert.deepEqual(outbox.map((m) => [m.to_email, m.subject]).sort(), [['existing@example.com', 'Welcome aboard'], ['mcp@example.com', 'Welcome aboard'], ['user@example.com', 'Welcome aboard']])
  const mail = outbox.find((m) => m.to_email === 'user@example.com')!
  const campaignId: string = created.data.steps[0].campaignId
  const delivery = deliveries(ctx, campaignId).find((d) => d.contact_id === contactId)!
  assert.equal(delivery.status, 'sent')
  const headers = parseHeaders(mail.headers)
  assert.equal(headers['X-MC-Delivery'], String(delivery.id))
  assert.match(headers['List-Unsubscribe'], /<mailto:unsubscribe@example\.com\?subject=unsubscribe>, <http:\/\/app\.example\.com\/u\//)
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.ok(headers['Feedback-ID'].startsWith(`${campaignId}:${nl.id}:`))
  assert.match(mail.html, /\/t\/o\//, 'the open pixel is there')
  assert.match(mail.text, /Glad you are here\./)
  // Stats, usage and the open land on the step campaign.
  const pixel = /http:\/\/app\.example\.com\/t\/o\/[A-Za-z0-9_.-]+/.exec(mail.html)![0]
  install.clock.advance(60_000)
  assert.equal((await install.fetch(pixel, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Thunderbird/128.0' } })).status, 200)
  const stats = await mcp('sequences_stats', { newsletterId: nl.id, sequenceId })
  assert.deepEqual(stats.structuredContent.steps.map((s: { sent: number; opens: number; waiting: number }) => [s.sent, s.opens, s.waiting]), [[3, 1, 0], [0, 0, 3]])
  assert.equal((await api('GET', `/campaigns/${campaignId}/report`)).data.counts.sent, 3)
  assert.equal(ctx.db.get<{ n: number }>('SELECT emails_sent AS n FROM usage WHERE period = ?', currentPeriod(ctx.now()))!.n, 3)
  assert.equal(countSentInPeriod(ctx, currentPeriod(ctx.now())), 3, 'the hourly recount sees sequence deliveries although their campaign stays a draft')
  // A lost usage counter is repaired from the delivery rows.
  ctx.db.run('UPDATE usage SET emails_sent = 0')
  ctx.jobs.cancelByKey('usage.push')
  ctx.jobs.enqueue('usage.push', {}, { dedupeKey: 'usage.push' })
  await install.runJobs()
  assert.equal(ctx.db.get<{ n: number }>('SELECT emails_sent AS n FROM usage WHERE period = ?', currentPeriod(ctx.now()))!.n, 3)
  // Pause and resume through the API, then the second step on day 3.
  assert.equal((await api('POST', `/newsletters/${nl.id}/sequences/${sequenceId}/pause`)).data.status, 'paused')
  assert.equal((await mcp('sequences_resume', { newsletterId: nl.id, sequenceId })).structuredContent.status, 'active')
  await pass(install, 2 * DAY)
  assert.equal(mails(install, accountId).filter((m) => m.endsWith('How is it going?')).length, 3)
  assert.equal((await api('GET', `/newsletters/${nl.id}/sequences/${sequenceId}`)).data.enrollments.completed, 3)
  const tools = (await (await install.fetch('/mcp', { method: 'POST', headers: { ...apiHeaders(key.secret), accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json()).result.tools as { name: string }[]
  for (const name of ['sequences_activate', 'sequences_pause', 'sequences_resume', 'sequences_enroll', 'sequences_exit', 'sequences_pauseEnrollment', 'sequences_resumeEnrollment', 'sequences_listEnrollments', 'sequences_stats']) assert.ok(tools.some((tool) => tool.name === name), `missing MCP tool ${name}`)
  assert.match(await (await install.fetch('/llms.txt')).text(), /Email sequences/)
})

test('imports and API calls enter tag sequences but not signup sequences; the public form enters signup sequences; confirming enters a waiting tag sequence', async (t) => {
  const { install, owner, nl, ctx, accountId, tag } = await setup()
  t.after(() => install.close())
  install.dns.set('example.com', 'MX', ['10 mx.example.com'])
  const byTag = await activeSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1], {}, 'By tag')
  const bySignup = await activeSequence(owner, nl.id, { type: 'signup' }, [1], {}, 'By signup')
  const manual = await activeSequence(owner, nl.id, { type: 'manual' }, [1], {}, 'By hand')
  const inSequences = (email: string) => ctx.db.all<{ name: string }>('SELECT s.name FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id JOIN contacts c ON c.id = e.contact_id WHERE c.email = ? ORDER BY s.name', email).map((r) => r.name)

  // An import with a tag.
  const importId = await upload(owner, nl.id, [{ email: 'imported@example.com', status: 'subscribed' }, { email: 'plain@example.com', status: 'subscribed' }], { mapping: { email: 'email', status: 'status' }, options: { consent: true, tagIds: [tag.id] } })
  assert.equal((await finish(install, owner, nl.id, importId)).added, 2)
  assert.deepEqual([inSequences('imported@example.com'), inSequences('plain@example.com')], [['By tag'], ['By tag']])
  assert.equal(ctx.db.get<{ source: string }>('SELECT e.source FROM sequence_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE c.email = ?', 'imported@example.com')!.source, 'import')
  // An API-style create without the tag enters nothing; several sequences at once are fine.
  const direct = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'direct@example.com', source: 'signup' })).contact
  assert.deepEqual(inSequences('direct@example.com'), [])
  await owner.action('sequences.enroll', { newsletterId: nl.id, sequenceId: manual.id, contactId: direct.id })
  await owner.action('contacts.bulk', { newsletterId: nl.id, contactIds: [direct.id], operation: 'tag', tagIds: [tag.id] })
  assert.deepEqual(inSequences('direct@example.com'), ['By hand', 'By tag'])

  // The public form with double opt-in: nothing until the reader confirms, then the signup sequence.
  const config: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${nl.key}`)).json()
  install.clock.advance(2001)
  assert.equal((await install.fetch(`/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'form@example.com', formToken: config.formToken }) })).status, 200)
  assert.deepEqual(inSequences('form@example.com'), [])
  const link = /http:\/\/app\.example\.com\/confirm\/[^\s<>"\]]+/.exec(install.outbox(accountId).find((m) => m.subject.startsWith('Confirm'))!.text)![0]
  assert.equal((await install.fetch(link)).status, 200)
  assert.deepEqual(inSequences('form@example.com'), ['By signup'])
  assert.equal((await install.fetch(link)).status, 200)
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ?", bySignup.id)!.n, 1)
  // Single opt-in enters on submit.
  await owner.action('newsletters.update', { newsletterId: nl.id, doubleOptIn: false })
  const config2: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${nl.key}`)).json()
  install.clock.advance(2001)
  assert.equal((await install.fetch(`/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'single@example.com', formToken: config2.formToken }) })).status, 200)
  assert.deepEqual(inSequences('single@example.com'), ['By signup'])

  // An unconfirmed contact who gains the entry tag waits; confirming enters them. Nobody else is picked up by a status change.
  const pending = subscribe(ctx, { newsletterId: nl.id, email: 'pending@example.com', source: 'test', consent: 'pending', tags: [tag.id], tagSource: 'api' }).contact
  assert.equal(pending.status, 'unconfirmed')
  assert.deepEqual(inSequences('pending@example.com'), [])
  subscribe(ctx, { newsletterId: nl.id, email: 'pending@example.com', source: 'test', consent: 'confirmed' })
  assert.deepEqual(inSequences('pending@example.com'), ['By tag'])
  assert.equal(enrollmentOf(ctx, byTag.id, pending.id)!.source, 'confirm')
  await pass(install, DAY)
  assert.deepEqual(mails(install, accountId).sort(), ['direct@example.com: Day 1', 'direct@example.com: Day 1', 'form@example.com: Day 1', 'imported@example.com: Day 1', 'pending@example.com: Day 1', 'plain@example.com: Day 1', 'single@example.com: Day 1'])
})

test('enrollment tools: manual entry and its refusals, keyset paging, the tag guard, and edits to a running sequence', async (t) => {
  const { install, owner, nl, ctx, accountId, tag, paid } = await setup()
  t.after(() => install.close())
  const other = await owner.action('newsletters.create', { name: 'Other' })
  const sequence = await activeSequence(owner, nl.id, { type: 'manual' }, [1, 2, 4], { tagIds: [paid.id] })
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const refused = async (fn: () => Promise<unknown>, status: number, code: string) => { const e = await expectError(fn); assert.deepEqual([e.status, e.code], [status, code]); return e }
  const add = async (email: string, tags: string[] = []) => (await owner.action('contacts.create', { newsletterId: nl.id, email, tags })).contact

  const gone = await add('gone@example.com')
  await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: gone.id })
  await refused(() => owner.action('sequences.enroll', { ...at, contactId: gone.id }), 409, 'not_subscribed')
  const payer = await add('payer@example.com', [paid.id])
  await refused(() => owner.action('sequences.enroll', { ...at, contactId: payer.id }), 409, 'exit_rule')
  await refused(() => owner.action('sequences.enroll', { ...at, contactId: 'ct_missing' }), 404, 'not_found')
  const foreign = (await owner.action('contacts.create', { newsletterId: other.id, email: 'foreign@example.com' })).contact
  await refused(() => owner.action('sequences.enroll', { ...at, contactId: foreign.id }), 404, 'not_found')
  for (const name of ['sequences.exit', 'sequences.pauseEnrollment', 'sequences.resumeEnrollment'] as const) {
    await refused(() => owner.action(name, { ...at, contactId: foreign.id }), 404, 'not_enrolled')
    await refused(() => owner.action(name, { ...at, contactId: gone.id }), 404, 'not_enrolled')
    await refused(() => owner.action(name, { newsletterId: other.id, sequenceId: sequence.id, contactId: foreign.id }), 404, 'not_found')
  }
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const contact = await add(`reader${i}@example.com`)
    await owner.action('sequences.enroll', { ...at, contactId: contact.id })
    ids.push(contact.id)
  }
  await refused(() => owner.action('sequences.enroll', { ...at, contactId: ids[0] }), 409, 'already_enrolled')
  await owner.action('sequences.pauseEnrollment', { ...at, contactId: ids[4] })

  // Paging: two at a time by contact id, each contact once; the status filter and a foreign cursor.
  const seen: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const result = await owner.action('sequences.listEnrollments', { ...at, limit: 2, cursor })
    seen.push(...result.enrollments.map((e) => e.contactId))
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  assert.deepEqual(seen, [...ids].sort())
  assert.deepEqual((await owner.action('sequences.listEnrollments', { ...at, status: 'paused' })).enrollments.map((e) => e.contactId), [ids[4]])
  assert.deepEqual((await owner.action('sequences.listEnrollments', { ...at, status: 'completed' })).enrollments, [])
  const elsewhere = await activeSequence(owner, nl.id, { type: 'manual' }, [1], {}, 'Elsewhere')
  await refused(() => owner.action('sequences.listEnrollments', { newsletterId: nl.id, sequenceId: elsewhere.id, cursor }), 400, 'invalid_input')
  await refused(() => owner.action('sequences.listEnrollments', { ...at, cursor: 'nonsense' }), 400, 'invalid_input')
  await refused(() => owner.action('sequences.listEnrollments', { newsletterId: other.id, sequenceId: sequence.id }), 404, 'not_found')

  // A tag a live or draft sequence depends on cannot be deleted; an archived sequence lets go of it.
  const byTag = await draftSequence(owner, nl.id, { type: 'tag', tagId: tag.id }, [1], {}, 'By tag')
  const inUse = await refused(() => owner.action('tags.delete', { newsletterId: nl.id, tagId: paid.id }), 409, 'tag_in_use')
  assert.deepEqual(inUse.details, { sequences: [{ id: sequence.id, name: 'Onboarding', status: 'active', uses: ['exit'] }] })
  const entryInUse = await refused(() => owner.action('tags.delete', { newsletterId: nl.id, tagId: tag.id }), 409, 'tag_in_use')
  assert.deepEqual(entryInUse.details, { sequences: [{ id: byTag.id, name: 'By tag', status: 'draft', uses: ['entry'] }] })
  assert.equal((await owner.action('tags.list', { newsletterId: nl.id })).tags.length, 2)
  await owner.action('sequences.archive', { newsletterId: nl.id, sequenceId: byTag.id })
  assert.deepEqual(await owner.action('tags.delete', { newsletterId: nl.id, tagId: tag.id }), { deleted: true })

  // Editing a running sequence: a new delay moves the contacts waiting for that step, a deleted step hands them on.
  const [s1, s2, s3] = sequence.steps
  const start = enrollmentOf(ctx, sequence.id, ids[0])!.enrolled_at
  await owner.action('sequences.updateStep', { ...at, stepId: s1.id, revision: s1.revision, delayDays: 2 })
  assert.equal(enrollmentOf(ctx, sequence.id, ids[0])!.next_run_at, start + 2 * DAY)
  assert.equal(enrollmentOf(ctx, sequence.id, ids[4])!.next_run_at, null, 'a paused contact stays without a time')
  const removed = await owner.action('sequences.deleteStep', { ...at, stepId: s1.id })
  assert.deepEqual(removed.steps.map((s) => s.id), [s2.id, s3.id])
  assert.deepEqual([enrollmentOf(ctx, sequence.id, ids[0])!.next_step_id, enrollmentOf(ctx, sequence.id, ids[0])!.next_run_at], [s2.id, start + 2 * DAY])
  assert.deepEqual([enrollmentOf(ctx, sequence.id, ids[4])!.next_step_id, enrollmentOf(ctx, sequence.id, ids[4])!.next_run_at], [s2.id, null])
  await pass(install, 2 * DAY)
  assert.deepEqual(mails(install, accountId).sort(), [0, 1, 2, 3].map((i) => `reader${i}@example.com: Day 2`))
  // A step added to a running sequence reaches the contacts who have not finished.
  const extra = await owner.action('sequences.addStep', { ...at, delayDays: 5, subject: 'Day 5' })
  await pass(install, 3 * DAY)
  assert.equal(mails(install, accountId).filter((m) => m.endsWith('Day 5')).length, 4)
  assert.equal(enrollmentOf(ctx, sequence.id, ids[0])!.last_step_id, extra.id)
  const contactView = await owner.action('contacts.get', { newsletterId: nl.id, contactId: ids[4] })
  assert.deepEqual(contactView.enrollments.map((e) => [e.sequenceId, e.name, e.status, e.nextRunAt]), [[sequence.id, 'Onboarding', 'paused', null]])
  assert.deepEqual((await owner.action('contacts.get', { newsletterId: other.id, contactId: foreign.id })).enrollments, [])
})
