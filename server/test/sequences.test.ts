import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createInstall, expectError, type Client, type Install } from './harness.ts'
import { finish, upload } from './imports-setup.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import { accountRegistry } from '../account/modules.ts'
import { contactTagsListeners, onContactTagsAdded, type ContactTagsAdded } from '../account/contacts/index.ts'
import { syncContactTags } from '../account/sequences/index.ts'
import { DELETE_STEPS } from '../account/newsletters/delete.ts'
import { markSentEffects } from '../account/sending/index.ts'
import { pushPolicy } from '../control/accounts/index.ts'

const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] })
const apiHeaders = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' })

async function setup(install: Install, email = 'owner@example.com') {
  const owner = await install.signUp({ email })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const ctx = install.app.account(owner.accountId!).ctx
  return { owner, nl, ctx }
}
/** Collects what the tag hook emits while a test runs. */
function listen(t: { after(fn: () => void): void }) {
  const events: ContactTagsAdded[] = []
  t.after(onContactTagsAdded((_ctx, event) => void events.push(event)))
  return events
}
const member = (client: Client, grants: Actor['grants']): Actor => ({ userId: client.session.user.id, email: client.email, owner: false, grants, access: 'full', via: 'web', installAdmin: false })
const rejects = (promise: Promise<unknown>, status: number, code?: string) => assert.rejects(promise, (e: unknown) => e instanceof AppError && e.status === status && (!code || e.code === code))

test('the migration creates the sequence tables with their checks, unique keys and indexes', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const { nl, ctx } = await setup(install)
  const db = ctx.db
  const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").map((r) => r.name)
  for (const name of ['sequences', 'sequence_steps', 'sequence_enrollments', 'sequences_newsletter', 'sequence_enrollments_due']) assert.ok(names.includes(name), `missing ${name}`)
  assert.ok(db.get("SELECT 1 FROM _migrations WHERE id = '2026-11-26-sequences-tables'"))
  assert.match(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'sequence_enrollments_due'")!.sql, /WHERE status = 'active'/)

  const insert = (id: string, status: string) => db.run("INSERT INTO sequences (id, newsletter_id, name, status, entry, created_by, created_at, updated_at) VALUES (?, ?, 'S', ?, '{\"type\":\"manual\"}', 'u', 1, 1)", id, nl.id, status)
  insert('seq_a', 'draft')
  assert.throws(() => insert('seq_b', 'running'), /CHECK/)
  assert.throws(() => db.run("UPDATE sequences SET delay_anchor = 'subscribed_at' WHERE id = 'seq_a'"), /CHECK/)
  assert.equal(db.get<{ delay_anchor: string; exit: string }>("SELECT delay_anchor, exit FROM sequences WHERE id = 'seq_a'")!.delay_anchor, 'enrolled_at')
  const step = (id: string, position: number, campaign: string) => db.run('INSERT INTO sequence_steps (id, sequence_id, position, delay_days, campaign_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 1)', id, 'seq_a', position, campaign)
  step('sst_a', 1, 'cmp_a')
  assert.throws(() => step('sst_b', 1, 'cmp_b'), /UNIQUE/)
  assert.throws(() => step('sst_b', 2, 'cmp_a'), /UNIQUE/)
  const enroll = (id: string, contact: string, status = 'active') => db.run('INSERT INTO sequence_enrollments (id, sequence_id, contact_id, status, enrolled_at, next_run_at) VALUES (?, ?, ?, ?, 1, 5)', id, 'seq_a', contact, status)
  enroll('enl_a', 'ct_a')
  assert.throws(() => enroll('enl_b', 'ct_a'), /UNIQUE/, 'a contact enters a sequence at most once')
  assert.throws(() => enroll('enl_b', 'ct_b', 'waiting'), /CHECK/)

  const plan = (sql: string, ...params: (string | number)[]) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(' | ')
  assert.match(plan("SELECT id, entry FROM sequences WHERE newsletter_id = ? AND status = 'active'", nl.id), /USING INDEX sequences_newsletter/)
  assert.match(plan("SELECT id FROM sequence_enrollments WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 100", 10), /USING (COVERING )?INDEX sequence_enrollments_due/)
  // Every sequence table is reachable from a newsletter for deletion.
  for (const table of ['sequences', 'sequence_steps', 'sequence_enrollments']) assert.ok(DELETE_STEPS.some((s) => s.table === table), `${table} is missing from DELETE_STEPS`)
  const order = DELETE_STEPS.map((s) => s.table)
  assert.ok(order.indexOf('sequence_enrollments') < order.indexOf('sequences') && order.indexOf('sequence_steps') < order.indexOf('sequences'), 'children go before sequences')
})

test('sequences: create, read, update, steps, reorder, archive, with validation, 404s and revision conflicts', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const { owner, nl, ctx } = await setup(install)
  const other = await owner.action('newsletters.create', { name: 'Other' })
  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'new-signup' })
  const paid = await owner.action('tags.create', { newsletterId: nl.id, name: 'paid' })
  const segment = await owner.action('segments.create', { newsletterId: nl.id, name: 'Everyone', filter: { field: 'status', in: ['subscribed'] } })
  const foreignTag = await owner.action('tags.create', { newsletterId: other.id, name: 'foreign' })
  const foreignSegment = await owner.action('segments.create', { newsletterId: other.id, name: 'Foreign', filter: { all: [] } })

  assert.deepEqual((await owner.action('sequences.list', { newsletterId: nl.id })).sequences, [])
  const created = await owner.action('sequences.create', { newsletterId: nl.id, name: '  Onboarding ', entry: { type: 'tag', tagId: tag.id }, exit: { tagIds: [paid.id], segmentId: segment.id }, steps: [{ delayDays: 1, subject: 'Day 1', doc: doc('Hello') }, { delayDays: 3, subject: 'Day 3' }] })
  assert.match(created.id, /^seq_[a-z2-7]{16}$/)
  assert.equal(created.name, 'Onboarding')
  assert.equal(created.status, 'draft')
  assert.equal(created.delayAnchor, 'enrolled_at')
  assert.deepEqual(created.entry, { type: 'tag', tagId: tag.id })
  assert.deepEqual(created.exit, { tagIds: [paid.id], segmentId: segment.id })
  assert.equal(created.stepCount, 2)
  assert.deepEqual(created.enrollments, { total: 0, active: 0, completed: 0, exited: 0 })
  assert.deepEqual(created.steps.map((s) => [s.position, s.delayDays, s.subject, s.revision]), [[1, 1, 'Day 1', 1], [2, 3, 'Day 3', 1]])
  assert.match(created.steps[0].id, /^sst_/)
  assert.deepEqual(created.steps[0].doc, doc('Hello'))
  // Each step owns a hidden draft campaign.
  const hidden = ctx.db.all<{ kind: string; status: string; web_visible: number; newsletter_id: string }>("SELECT kind, status, web_visible, newsletter_id FROM campaigns WHERE id IN (?, ?)", created.steps[0].campaignId, created.steps[1].campaignId)
  assert.deepEqual(hidden.map((r) => ({ ...r })), [0, 1].map(() => ({ kind: 'sequence', status: 'draft', web_visible: 0, newsletter_id: nl.id })))

  const manual = await owner.action('sequences.create', { newsletterId: nl.id, name: 'By hand', entry: { type: 'manual' } })
  assert.deepEqual([manual.exit, manual.steps], [{}, []])
  assert.equal((await owner.action('sequences.create', { newsletterId: nl.id, name: 'Form', entry: { type: 'signup' } })).entry.type, 'signup')
  assert.equal((await owner.action('sequences.create', { newsletterId: nl.id, name: 'Segment', entry: { type: 'segment', segmentId: segment.id } })).entry.type, 'segment')
  const listed = await owner.action('sequences.list', { newsletterId: nl.id })
  assert.equal(listed.sequences.length, 4)
  assert.equal(listed.sequences.find((s) => s.id === created.id)!.stepCount, 2)
  assert.deepEqual((await owner.action('sequences.list', { newsletterId: other.id })).sequences, [])
  assert.deepEqual(await owner.action('sequences.get', { newsletterId: nl.id, sequenceId: created.id }), created)

  // Validation.
  const base = { newsletterId: nl.id, name: 'Bad', entry: { type: 'manual' as const } }
  for (const bad of [
    { ...base, name: ' ' }, { ...base, entry: { type: 'tag' } }, { ...base, entry: { type: 'webhook' } }, { ...base, entry: undefined },
    { ...base, steps: [{ delayDays: 0, subject: 'Day 0' }] }, { ...base, steps: [{ delayDays: 1.5 }] }, { ...base, steps: [{ delayDays: 731 }] }, { ...base, steps: [{ subject: 'No delay' }] },
    { ...base, steps: [{ delayDays: 1, doc: { type: 'paragraph' } }] }, { ...base, steps: Array.from({ length: 51 }, () => ({ delayDays: 1 })) },
  ]) {
    const response = await owner.actionRaw('sequences.create', bad)
    assert.equal(response.status, 400, JSON.stringify(bad).slice(0, 120))
    assert.equal((await response.json()).code, 'invalid_input')
  }
  // Tags and segments must exist in the same newsletter; a failed create leaves nothing behind.
  const before = ctx.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM sequences) + (SELECT COUNT(*) FROM campaigns) AS n')!.n
  for (const rules of [{ entry: { type: 'tag' as const, tagId: foreignTag.id } }, { entry: { type: 'tag' as const, tagId: 'tag_missing' } }, { entry: { type: 'segment' as const, segmentId: foreignSegment.id } }, { entry: { type: 'manual' as const }, exit: { tagIds: [paid.id, foreignTag.id] } }, { entry: { type: 'manual' as const }, exit: { segmentId: foreignSegment.id } }]) {
    const error = await expectError(() => owner.action('sequences.create', { newsletterId: nl.id, name: 'Foreign', steps: [{ delayDays: 1 }], ...rules }))
    assert.deepEqual([error.status, error.code], [404, 'not_found'], JSON.stringify(rules))
  }
  assert.equal(ctx.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM sequences) + (SELECT COUNT(*) FROM campaigns) AS n')!.n, before)

  // 404s: unknown ids, and a sequence named under the wrong newsletter.
  assert.equal((await expectError(() => owner.action('sequences.get', { newsletterId: nl.id, sequenceId: 'seq_missing' }))).status, 404)
  assert.equal((await expectError(() => owner.action('sequences.get', { newsletterId: other.id, sequenceId: created.id }))).status, 404)
  assert.equal((await expectError(() => owner.action('sequences.update', { newsletterId: other.id, sequenceId: created.id, name: 'Stolen' }))).status, 404)
  assert.equal((await expectError(() => owner.action('sequences.updateStep', { newsletterId: nl.id, sequenceId: manual.id, stepId: created.steps[0].id, revision: 1, subject: 'Wrong sequence' }))).status, 404)
  assert.equal((await expectError(() => owner.action('sequences.deleteStep', { newsletterId: nl.id, sequenceId: created.id, stepId: 'sst_missing' }))).status, 404)

  // Update: omitted fields stay, rules are validated.
  install.clock.advance(1000)
  const renamed = await owner.action('sequences.update', { newsletterId: nl.id, sequenceId: created.id, name: 'Onboarding v2' })
  assert.deepEqual([renamed.name, renamed.entry, renamed.exit], ['Onboarding v2', created.entry, created.exit])
  assert.ok(renamed.updatedAt > created.updatedAt)
  const rules = await owner.action('sequences.update', { newsletterId: nl.id, sequenceId: created.id, entry: { type: 'tag', tagId: paid.id }, exit: {} })
  assert.deepEqual([rules.name, rules.entry, rules.exit], ['Onboarding v2', { type: 'tag', tagId: paid.id }, {}])
  assert.equal((await expectError(() => owner.action('sequences.update', { newsletterId: nl.id, sequenceId: created.id, entry: { type: 'tag', tagId: foreignTag.id } }))).status, 404)
  assert.equal((await expectError(() => owner.action('sequences.update', { newsletterId: nl.id, sequenceId: created.id, exit: { tagIds: [foreignTag.id] } }))).status, 404)
  // Once a contact has entered, the entry rule is locked; the rest still changes.
  const contact = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com' })).contact
  ctx.db.run("INSERT INTO sequence_enrollments (id, sequence_id, contact_id, status, enrolled_at) VALUES ('enl_1', ?, ?, 'completed', ?)", created.id, contact.id, ctx.now())
  const locked = await expectError(() => owner.action('sequences.update', { newsletterId: nl.id, sequenceId: created.id, entry: { type: 'tag', tagId: tag.id } }))
  assert.deepEqual([locked.status, locked.code], [409, 'entry_locked'])
  const same = await owner.action('sequences.update', { newsletterId: nl.id, sequenceId: created.id, name: 'Onboarding v3', entry: { type: 'tag', tagId: paid.id }, exit: { tagIds: [tag.id] } })
  assert.deepEqual([same.name, same.exit, same.enrollments], ['Onboarding v3', { tagIds: [tag.id] }, { total: 1, active: 0, completed: 1, exited: 0 }])
  assert.equal((await owner.action('sequences.list', { newsletterId: nl.id })).sequences.find((s) => s.id === created.id)!.enrollments.total, 1)

  // Steps.
  const added = await owner.action('sequences.addStep', { newsletterId: nl.id, sequenceId: created.id, delayDays: 7, subject: 'Day 7' })
  assert.deepEqual([added.position, added.delayDays, added.subject, added.revision], [3, 7, 'Day 7', 1])
  assert.equal((await expectError(() => owner.action('sequences.addStep', { newsletterId: nl.id, sequenceId: created.id, delayDays: 0 }))).code, 'invalid_input')
  const saved = await owner.action('sequences.updateStep', { newsletterId: nl.id, sequenceId: created.id, stepId: added.id, revision: 1, delayDays: 10, subject: 'Day 10', doc: doc('Ten') })
  assert.deepEqual([saved.delayDays, saved.subject, saved.doc, saved.revision, saved.position], [10, 'Day 10', doc('Ten'), 2, 3])
  const partial = await owner.action('sequences.updateStep', { newsletterId: nl.id, sequenceId: created.id, stepId: added.id, revision: 2, previewText: 'Preview' })
  assert.deepEqual([partial.delayDays, partial.subject, partial.doc, partial.previewText, partial.revision], [10, 'Day 10', doc('Ten'), 'Preview', 3])
  const stale = await expectError(() => owner.action('sequences.updateStep', { newsletterId: nl.id, sequenceId: created.id, stepId: added.id, revision: 2, subject: 'Stale' }))
  assert.deepEqual([stale.status, stale.code, stale.details], [409, 'revision_conflict', { revision: 3 }])
  // The campaign editor saves the same row, and the two share one revision.
  const viaEditor = await owner.action('campaigns.update', { campaignId: added.campaignId, revision: 3, subject: 'From the editor' })
  assert.deepEqual([viaEditor.kind, viaEditor.status, viaEditor.revision], ['sequence', 'draft', 4])
  assert.equal((await expectError(() => owner.action('sequences.updateStep', { newsletterId: nl.id, sequenceId: created.id, stepId: added.id, revision: 3, subject: 'Stale' }))).code, 'revision_conflict')
  assert.equal((await owner.action('campaigns.get', { campaignId: added.campaignId })).subject, 'From the editor')

  // Reorder: every step exactly once.
  const [first, second] = created.steps
  const reordered = await owner.action('sequences.reorderSteps', { newsletterId: nl.id, sequenceId: created.id, stepIds: [added.id, first.id, second.id] })
  assert.deepEqual(reordered.steps.map((s) => [s.id, s.position, s.delayDays]), [[added.id, 1, 10], [first.id, 2, 1], [second.id, 3, 3]])
  for (const stepIds of [[first.id, second.id], [first.id, first.id, second.id], [first.id, second.id, added.id, added.id]]) assert.equal((await expectError(() => owner.action('sequences.reorderSteps', { newsletterId: nl.id, sequenceId: created.id, stepIds }))).code, 'invalid_input')
  assert.equal((await expectError(() => owner.action('sequences.reorderSteps', { newsletterId: nl.id, sequenceId: created.id, stepIds: [first.id, second.id, 'sst_missing'] }))).status, 404)
  assert.deepEqual((await owner.action('sequences.get', { newsletterId: nl.id, sequenceId: created.id })).steps.map((s) => s.id), [added.id, first.id, second.id])

  // Delete: refused once the step has a delivery; otherwise the step and its campaign go and the rest closes up.
  ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at) VALUES (?, ?, 'reader@example.com', 'sent', ?)", first.campaignId, contact.id, ctx.now())
  const sent = await expectError(() => owner.action('sequences.deleteStep', { newsletterId: nl.id, sequenceId: created.id, stepId: first.id }))
  assert.deepEqual([sent.status, sent.code], [409, 'step_sent'])
  const removed = await owner.action('sequences.deleteStep', { newsletterId: nl.id, sequenceId: created.id, stepId: added.id })
  assert.deepEqual(removed.steps.map((s) => [s.id, s.position]), [[first.id, 1], [second.id, 2]])
  assert.equal(ctx.db.get('SELECT id FROM campaigns WHERE id = ?', added.campaignId), undefined)
  assert.equal((await expectError(() => owner.action('campaigns.get', { campaignId: added.campaignId }))).status, 404)

  // Archive: out of the default list, read-only, idempotent, and never deleted.
  install.clock.advance(1000)
  const archived = await owner.action('sequences.archive', { newsletterId: nl.id, sequenceId: created.id })
  assert.deepEqual([archived.status, archived.archivedAt, archived.steps.length], ['archived', ctx.now(), 2])
  install.clock.advance(1000)
  assert.equal((await owner.action('sequences.archive', { newsletterId: nl.id, sequenceId: created.id })).archivedAt, archived.archivedAt)
  assert.ok(!(await owner.action('sequences.list', { newsletterId: nl.id })).sequences.some((s) => s.id === created.id))
  assert.ok((await owner.action('sequences.list', { newsletterId: nl.id, includeArchived: true })).sequences.some((s) => s.id === created.id))
  assert.equal((await owner.action('sequences.get', { newsletterId: nl.id, sequenceId: created.id })).status, 'archived')
  for (const attempt of [
    () => owner.action('sequences.update', { newsletterId: nl.id, sequenceId: created.id, name: 'Late' }),
    () => owner.action('sequences.addStep', { newsletterId: nl.id, sequenceId: created.id, delayDays: 2 }),
    () => owner.action('sequences.updateStep', { newsletterId: nl.id, sequenceId: created.id, stepId: second.id, revision: 1, subject: 'Late' }),
    () => owner.action('sequences.deleteStep', { newsletterId: nl.id, sequenceId: created.id, stepId: second.id }),
    () => owner.action('sequences.reorderSteps', { newsletterId: nl.id, sequenceId: created.id, stepIds: [second.id, first.id] }),
  ]) assert.deepEqual([(await expectError(attempt)).status, (await expectError(attempt)).code], [409, 'sequence_archived'])
  // This unit has no way to start a sequence.
  for (const name of ['sequences.activate', 'sequences.delete', 'sequences.enroll']) assert.ok(!accountRegistry.actions.has(name), `${name} must not exist yet`)
  assert.deepEqual(ctx.db.all<{ status: string }>('SELECT DISTINCT status FROM sequences ORDER BY status').map((r) => r.status), ['archived', 'draft'])
})

test('a sequence step email is hidden from campaign lists and cannot be sent, scheduled, canceled, duplicated, deleted or published', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const { owner, nl, ctx } = await setup(install)
  const issue = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Issue one' })
  const sequence = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'manual' }, steps: [{ delayDays: 1, subject: 'Step one', doc: doc(`${nl.id}/abcdefgh12345678.png`) }] })
  const campaignId = sequence.steps[0].campaignId

  const list = await owner.action('campaigns.list', { newsletterId: nl.id })
  assert.deepEqual([list.campaigns.map((c) => c.id), list.total], [[issue.id], 1])
  assert.equal((await owner.action('campaigns.list', { newsletterId: nl.id, search: 'Step one', status: 'draft' })).total, 0)

  const refused = async (fn: () => Promise<unknown>, code: string) => { const e = await expectError(fn); assert.deepEqual([e.status, e.code], [409, code]) }
  await refused(() => owner.action('campaigns.send', { campaignId }), 'not_issue')
  await refused(() => owner.action('campaigns.schedule', { campaignId, scheduledAt: ctx.now() + 3_600_000 }), 'not_issue')
  await refused(() => owner.action('campaigns.cancel', { campaignId }), 'sequence_step')
  await refused(() => owner.action('campaigns.duplicate', { campaignId }), 'sequence_step')
  await refused(() => owner.action('campaigns.delete', { campaignId, revision: 1 }), 'sequence_step')
  await refused(() => owner.action('website.updateIssue', { campaignId, slug: 'step-one', visible: true }), 'not_sent')
  const row = ctx.db.get<{ status: string; kind: string; web_visible: number; revision: number }>('SELECT status, kind, web_visible, revision FROM campaigns WHERE id = ?', campaignId)
  assert.deepEqual({ ...row }, { status: 'draft', kind: 'sequence', web_visible: 0, revision: 1 })
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaigns WHERE newsletter_id = ?', nl.id)!.n, 2)
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE instr(payload, ?) > 0', campaignId)!.n, 0)

  // Even a step forced to look sent stays off the website, the overview and issue-based engagement.
  ctx.db.run("UPDATE campaigns SET status = 'sent', sent_at = ?, web_visible = 1, slug = 'step-one' WHERE id = ?", ctx.now(), campaignId)
  assert.equal((await install.fetch(`/n/${nl.slug}/step-one`)).status, 404)
  assert.ok(!(await (await install.fetch(`/n/${nl.slug}`)).text()).includes('Step one'))
  const overview = await owner.action('stats.overview', { newsletterId: nl.id })
  assert.deepEqual([overview.campaigns, overview.checklist.campaign], [[], false])
  const contact = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com' })).contact
  ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, sent_at, queued_at) VALUES (?, ?, 'reader@example.com', 'sent', ?, ?)", campaignId, contact.id, ctx.now(), ctx.now())
  assert.equal((await owner.action('segments.count', { newsletterId: nl.id, filter: { field: 'engagement', op: 'ignoredLast', issues: 1 } })).count, 0)
  // A sequence email counts as sent but never toward the ignored-issues streak that hygiene acts on.
  const delivery = ctx.db.get<{ id: number }>('SELECT id FROM deliveries WHERE campaign_id = ?', campaignId)!
  markSentEffects(ctx, { id: delivery.id, campaign_id: campaignId, contact_id: contact.id }, nl.id, ctx.now())
  assert.deepEqual({ ...ctx.db.get<object>('SELECT sent_count, ignored_streak, strict_ignored_streak FROM contacts WHERE id = ?', contact.id) }, { sent_count: 1, ignored_streak: 0, strict_ignored_streak: 0 })
  // Image usage still reports the step, labelled by kind, so an image it uses is not deleted from under it.
  ctx.db.run("INSERT INTO uploads (key, newsletter_id, content_type, bytes, created_by, created_at) VALUES (?, ?, 'image/png', 1, 'u', 1)", `${nl.id}/abcdefgh12345678.png`, nl.id)
  const usage = await owner.action('campaigns.imageUsage', { newsletterId: nl.id, imageId: 'abcdefgh12345678.png' })
  assert.deepEqual(usage.campaigns.map((c) => [c.id, c.kind]), [[campaignId, 'sequence']])
})

test('deleting a newsletter removes its sequences, steps, step emails and enrollments and leaves other newsletters alone', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const { owner, nl, ctx } = await setup(install)
  const kept = await owner.action('newsletters.create', { name: 'Kept' })
  const ids: Record<string, string> = {}
  for (const n of [nl, kept]) {
    const tag = await owner.action('tags.create', { newsletterId: n.id, name: 'new-signup' })
    const sequence = await owner.action('sequences.create', { newsletterId: n.id, name: 'Onboarding', entry: { type: 'tag', tagId: tag.id }, steps: [{ delayDays: 1 }, { delayDays: 2 }] })
    const contact = (await owner.action('contacts.create', { newsletterId: n.id, email: 'reader@example.com', tags: [tag.id] })).contact
    ctx.db.run("INSERT INTO sequence_enrollments (id, sequence_id, contact_id, enrolled_at, next_run_at) VALUES (?, ?, ?, 1, 2)", `enl_${n.id}`, sequence.id, contact.id)
    ids[n.id] = sequence.id
  }
  const counts = () => ({ ...ctx.db.get<{ sequences: number; steps: number; enrollments: number; campaigns: number }>("SELECT (SELECT COUNT(*) FROM sequences) sequences, (SELECT COUNT(*) FROM sequence_steps) steps, (SELECT COUNT(*) FROM sequence_enrollments) enrollments, (SELECT COUNT(*) FROM campaigns WHERE kind = 'sequence') campaigns") })
  assert.deepEqual(counts(), { sequences: 2, steps: 4, enrollments: 2, campaigns: 4 })
  await owner.action('newsletters.delete', { newsletterId: nl.id, confirmName: 'Weekly' })
  for (let i = 0; i < 50 && ctx.db.get('SELECT id FROM newsletters WHERE id = ?', nl.id); i++) { await install.runJobs(); install.clock.advance(2000) }
  assert.equal(ctx.db.get('SELECT id FROM newsletters WHERE id = ?', nl.id), undefined)
  assert.deepEqual(counts(), { sequences: 1, steps: 2, enrollments: 1, campaigns: 2 })
  for (const step of DELETE_STEPS) assert.equal(ctx.db.all(step.select, nl.id, 10).length, 0, step.table)
  const survivor = await owner.action('sequences.get', { newsletterId: kept.id, sequenceId: ids[kept.id] })
  assert.deepEqual([survivor.steps.length, survivor.enrollments.total], [2, 1])
})

test('sequence permissions: members read, admins write, and nothing crosses newsletters or accounts', async (t) => {
  const install = await createInstall({ cloud: true })
  t.after(() => install.close())
  const { owner, nl, ctx } = await setup(install)
  pushPolicy(install.app.control.ctx, owner.accountId!, { plan: 'pro' })
  await install.runJobs()
  const other = await owner.action('newsletters.create', { name: 'Other' })
  const teammate = await install.signUp({ email: 'member@example.com' })
  const sequence = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'manual' }, steps: [{ delayDays: 1, subject: 'Secret subject' }] })
  const foreign = await owner.action('sequences.create', { newsletterId: other.id, name: 'Other onboarding', entry: { type: 'manual' }, steps: [{ delayDays: 1 }] })
  const step = sequence.steps[0]
  const at = { newsletterId: nl.id, sequenceId: sequence.id }
  const writes: [string, Record<string, unknown>][] = [
    ['sequences.create', { newsletterId: nl.id, name: 'Mine', entry: { type: 'manual' } }], ['sequences.update', { ...at, name: 'Mine' }], ['sequences.archive', at],
    ['sequences.reorderSteps', { ...at, stepIds: [step.id] }], ['sequences.addStep', { ...at, delayDays: 2 }],
    ['sequences.updateStep', { ...at, stepId: step.id, revision: 1, subject: 'Mine' }], ['sequences.deleteStep', { ...at, stepId: step.id }],
  ]
  const reads: [string, Record<string, unknown>][] = [['sequences.list', { newsletterId: nl.id }], ['sequences.get', at]]

  const asMember = member(teammate, { [nl.id]: 'member' })
  for (const [name, input] of reads) await runAction(ctx, name, input, asMember)
  for (const [name, input] of writes) await rejects(runAction(ctx, name, input, asMember), 403)
  // The campaign editor is not a way around it: a member may read a step email but not save it.
  await runAction(ctx, 'campaigns.get', { campaignId: step.campaignId }, asMember)
  await rejects(runAction(ctx, 'campaigns.update', { campaignId: step.campaignId, revision: 1, subject: 'Member edit' }, asMember), 403)
  assert.equal((await owner.action('sequences.get', at)).steps[0].subject, 'Secret subject')

  // An admin of another newsletter, a read-only key and a stranger get nothing.
  const elsewhere = member(teammate, { [other.id]: 'admin' })
  for (const [name, input] of [...reads, ...writes]) await rejects(runAction(ctx, name, input, elsewhere), 403)
  // Naming their own newsletter with a foreign sequence, or a foreign step in their own sequence, is a 404.
  await rejects(runAction(ctx, 'sequences.get', { newsletterId: other.id, sequenceId: sequence.id }, elsewhere), 404)
  await rejects(runAction(ctx, 'sequences.updateStep', { newsletterId: other.id, sequenceId: foreign.id, stepId: step.id, revision: 1, subject: 'Cross' }, elsewhere), 404)
  await rejects(runAction(ctx, 'sequences.reorderSteps', { newsletterId: other.id, sequenceId: foreign.id, stepIds: [step.id] }, elsewhere), 404)
  await rejects(runAction(ctx, 'sequences.deleteStep', { newsletterId: other.id, sequenceId: foreign.id, stepId: step.id }, elsewhere), 404)
  const readOnly: Actor = { ...member(teammate, {}), owner: true, access: 'read', via: 'api' }
  for (const [name, input] of reads) await runAction(ctx, name, input, readOnly)
  for (const [name, input] of writes) await rejects(runAction(ctx, name, input, readOnly), 403)
  for (const [name, input] of [...reads, ...writes]) await rejects(runAction(ctx, name, input, member(teammate, {})), 403)

  // Another account's store has never heard of this sequence.
  const stranger = await install.signUp({ email: 'stranger@example.com' })
  const theirs = await stranger.action('newsletters.create', { name: 'Theirs' })
  for (const input of [at, { newsletterId: theirs.id, sequenceId: sequence.id }]) assert.equal((await expectError(() => stranger.action('sequences.get', input))).status, 404)
  assert.equal((await expectError(() => stranger.action('sequences.archive', at))).status, 404)
  assert.equal((await expectError(() => stranger.action('sequences.list', { newsletterId: nl.id }))).status, 404)
  // Admin writes went nowhere above; now an admin of the right newsletter may make them.
  assert.equal((await owner.action('sequences.get', at)).status, 'draft')
  const asAdmin = member(teammate, { [nl.id]: 'admin' })
  await runAction(ctx, 'campaigns.update', { campaignId: step.campaignId, revision: 1, subject: 'Admin edit' }, asAdmin)
  for (const [name, input] of writes.filter(([n]) => !['sequences.updateStep', 'sequences.deleteStep', 'sequences.archive'].includes(n))) await runAction(ctx, name, input, asAdmin)
  await runAction(ctx, 'sequences.updateStep', { ...at, stepId: step.id, revision: 2, subject: 'Admin step' }, asAdmin)
  await runAction(ctx, 'sequences.archive', at, asAdmin)
})

test('the tag hook fires once for every tag a contact newly gains, on every write path, and never for tags already there or removals', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  install.dns.set('example.com', 'MX', ['10 mx.example.com'])
  const { owner, nl, ctx } = await setup(install)
  const other = await owner.action('newsletters.create', { name: 'Other' })
  const [signup, paid, vip] = await Promise.all(['new-signup', 'paid', 'vip'].map((name) => owner.action('tags.create', { newsletterId: nl.id, name })))
  const foreignTag = await owner.action('tags.create', { newsletterId: other.id, name: 'foreign' })
  const events = listen(t)
  const take = () => events.splice(0)
  const tagsOf = async (contactId: string) => (await owner.action('contacts.get', { newsletterId: nl.id, contactId })).tags.map((tag) => tag.id).sort()

  // contacts.create: a new contact with tags.
  const ada = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', tags: [signup.id] })).contact
  assert.deepEqual(take(), [{ newsletterId: nl.id, contactId: ada.id, tagIds: [signup.id], source: 'manual' }])
  // contacts.create without tags, and again with a tag it already has: silence.
  const bob = (await owner.action('contacts.create', { newsletterId: nl.id, email: 'bob@example.com' })).contact
  assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', tags: [signup.id] })).outcome, 'exists')
  assert.deepEqual(take(), [])
  // contacts.create again on an existing email with a new tag: only the new tag.
  const again = await owner.action('contacts.create', { newsletterId: nl.id, email: 'Ada@Example.com', tags: [signup.id, paid.id, paid.id] })
  assert.deepEqual([again.created, again.contact.id], [false, ada.id])
  assert.deepEqual(take(), [{ newsletterId: nl.id, contactId: ada.id, tagIds: [paid.id], source: 'manual' }])
  // The caller's free-text `source` never passes for a write path.
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'eve@example.com', tags: [signup.id], source: 'signup' })
  assert.equal(take()[0].source, 'manual')

  // contacts.update with addTagIds and removeTagIds.
  const updated = await owner.action('contacts.update', { newsletterId: nl.id, contactId: bob.id, name: 'Bob', addTagIds: [signup.id, vip.id] })
  assert.equal(updated.name, 'Bob')
  assert.deepEqual(take(), [{ newsletterId: nl.id, contactId: bob.id, tagIds: [signup.id, vip.id], source: 'manual' }])
  assert.deepEqual(await tagsOf(bob.id), [signup.id, vip.id].sort())
  await owner.action('contacts.update', { newsletterId: nl.id, contactId: bob.id, addTagIds: [vip.id], removeTagIds: [signup.id, paid.id] })
  assert.deepEqual(take(), [], 'a tag already there and removals emit nothing')
  assert.deepEqual(await tagsOf(bob.id), [vip.id])
  // Removed, then added again: the contact newly gains it again.
  await owner.action('contacts.update', { newsletterId: nl.id, contactId: bob.id, addTagIds: [signup.id] })
  assert.deepEqual(take(), [{ newsletterId: nl.id, contactId: bob.id, tagIds: [signup.id], source: 'manual' }])
  await owner.action('contacts.update', { newsletterId: nl.id, contactId: bob.id, name: 'Robert' })
  assert.deepEqual(take(), [])

  // contacts.bulk tag: one event per contact that gained something; untag and delete: none.
  const result = await owner.action('contacts.bulk', { newsletterId: nl.id, contactIds: [ada.id, bob.id, bob.id], operation: 'tag', tagIds: [paid.id, vip.id] })
  assert.equal(result.changed, 2)
  assert.deepEqual(take(), [{ newsletterId: nl.id, contactId: ada.id, tagIds: [vip.id], source: 'bulk' }, { newsletterId: nl.id, contactId: bob.id, tagIds: [paid.id], source: 'bulk' }])
  await owner.action('contacts.bulk', { newsletterId: nl.id, contactIds: [ada.id, bob.id], operation: 'tag', tagIds: [paid.id, vip.id] })
  await owner.action('contacts.bulk', { newsletterId: nl.id, contactIds: [ada.id], operation: 'untag', tagIds: [vip.id] })
  assert.deepEqual(await tagsOf(ada.id), [paid.id, signup.id].sort())
  await owner.action('tags.delete', { newsletterId: nl.id, tagId: vip.id })
  assert.deepEqual(await tagsOf(bob.id), [paid.id, signup.id].sort())
  await owner.action('contacts.delete', { newsletterId: nl.id, contactId: bob.id })
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_tags WHERE contact_id = ?', bob.id)!.n, 0)
  assert.deepEqual(take(), [])

  // An import: tags from the options and from the file's tag column, for new rows.
  const importId = await upload(owner, nl.id, [{ email: 'imported@example.com', status: 'subscribed', tags: 'paid; fresh' }, { email: 'plain@example.com', status: 'subscribed', tags: '' }], { mapping: { email: 'email', status: 'status', tags: 'tags' }, options: { consent: true, tagIds: [signup.id] } })
  assert.equal((await finish(install, owner, nl.id, importId)).added, 2)
  const fresh = ctx.db.get<{ id: string }>("SELECT id FROM tags WHERE newsletter_id = ? AND name = 'fresh'", nl.id)!
  const contactId = (email: string) => ctx.db.get<{ id: string }>('SELECT id FROM contacts WHERE newsletter_id = ? AND email = ?', nl.id, email)!.id
  assert.deepEqual(take().map((e) => ({ ...e, tagIds: [...e.tagIds].sort() })), [
    { newsletterId: nl.id, contactId: contactId('imported@example.com'), tagIds: [signup.id, paid.id, fresh.id].sort(), source: 'import' },
    { newsletterId: nl.id, contactId: contactId('plain@example.com'), tagIds: [signup.id], source: 'import' },
  ])

  // Failed writes: nothing is emitted and nothing is stored.
  const tagRows = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_tags')!.n
  const before = tagRows()
  const failures: [() => Promise<unknown>, number][] = [
    [() => owner.action('contacts.create', { newsletterId: nl.id, email: 'new@example.com', tags: [signup.id, foreignTag.id] }), 404],
    [() => owner.action('contacts.create', { newsletterId: nl.id, email: 'new@example.com', tags: [signup.id], fields: { nope: 'x' } }), 400],
    [() => owner.action('contacts.update', { newsletterId: nl.id, contactId: ada.id, addTagIds: [foreignTag.id] }), 404],
    [() => owner.action('contacts.update', { newsletterId: nl.id, contactId: ada.id, removeTagIds: ['tag_missing'] }), 404],
    [() => owner.action('contacts.update', { newsletterId: nl.id, contactId: ada.id, addTagIds: [paid.id], removeTagIds: [paid.id] }), 400],
    [() => owner.action('contacts.update', { newsletterId: other.id, contactId: ada.id, addTagIds: [foreignTag.id] }), 404],
    [() => owner.action('contacts.bulk', { newsletterId: nl.id, contactIds: [ada.id, 'ct_missing'], operation: 'tag', tagIds: [fresh.id] }), 404],
    [() => owner.action('contacts.bulk', { newsletterId: nl.id, contactIds: [ada.id], operation: 'tag', tagIds: [fresh.id, foreignTag.id] }), 404],
  ]
  for (const [attempt, status] of failures) assert.equal((await expectError(attempt)).status, status)
  // A suppressed address is not tagged.
  await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: ada.id })
  assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: 'ada@example.com', tags: [fresh.id] })).outcome, 'suppressed')
  assert.deepEqual([take(), tagRows()], [[], before])
  assert.equal(ctx.db.get('SELECT id FROM contacts WHERE email = ?', 'new@example.com'), undefined)

  // A listener runs inside the write's transaction: when it throws, the tag and the contact roll back.
  const off = onContactTagsAdded(() => { throw new AppError('listener_failed', 'No.', 409) })
  try {
    assert.equal((await expectError(() => owner.action('contacts.create', { newsletterId: nl.id, email: 'rolled@example.com', tags: [signup.id] }))).code, 'listener_failed')
    assert.equal((await expectError(() => owner.action('contacts.update', { newsletterId: nl.id, contactId: contactId('plain@example.com'), name: 'Changed', addTagIds: [paid.id] }))).code, 'listener_failed')
  } finally { off() }
  assert.equal(ctx.db.get('SELECT id FROM contacts WHERE email = ?', 'rolled@example.com'), undefined)
  assert.equal(ctx.db.get<{ name: string }>('SELECT name FROM contacts WHERE id = ?', contactId('plain@example.com'))!.name, '')
  assert.equal(tagRows(), before)
  take()
  // The listener sees the committed-to-be state: the contact row and its tag already exist.
  let seen: unknown
  const peek = onContactTagsAdded((c, e) => { seen = c.db.get('SELECT c.status, (SELECT COUNT(*) FROM contact_tags WHERE contact_id = c.id) AS tags FROM contacts c WHERE c.id = ?', e.contactId) })
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'seen@example.com', tags: [signup.id] })
  peek()
  assert.deepEqual({ ...seen as object }, { status: 'subscribed', tags: 1 })
})

test('tags added through the REST API and MCP with an API key reach the hook: the path app signups take', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const { owner, nl } = await setup(install)
  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'new-signup' })
  const paid = await owner.action('tags.create', { newsletterId: nl.id, name: 'paid' })
  const key = await owner.action('apikeys.create', { name: 'App', access: 'full' })
  const readKey = await owner.action('apikeys.create', { name: 'Reader', access: 'read' })
  const events = listen(t)
  const api = (method: string, path: string, body?: unknown, secret = key.secret) => install.fetch(`/api/v1${path}`, { method, headers: apiHeaders(secret), body: body === undefined ? undefined : JSON.stringify(body) })

  // POST /contacts with a tag: a new contact.
  const created = await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'user@example.com', tags: [tag.id], source: 'app' })
  assert.equal(created.status, 200)
  const contact = (await created.json()).contact
  assert.deepEqual(events.splice(0), [{ newsletterId: nl.id, contactId: contact.id, tagIds: [tag.id], source: 'api' }])
  // POST again for the same email with another tag: the existing contact gains it.
  const repeat = await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'user@example.com', tags: [tag.id, paid.id] })
  assert.deepEqual([(await repeat.json()).outcome, events.splice(0)], ['exists', [{ newsletterId: nl.id, contactId: contact.id, tagIds: [paid.id], source: 'api' }]])
  // PATCH /contacts/:id with addTagIds / removeTagIds.
  const untagged = await api('PATCH', `/newsletters/${nl.id}/contacts/${contact.id}`, { removeTagIds: [tag.id] })
  assert.equal(untagged.status, 200)
  assert.deepEqual(events.splice(0), [])
  const patched = await api('PATCH', `/newsletters/${nl.id}/contacts/${contact.id}`, { addTagIds: [tag.id] })
  assert.equal(patched.status, 200)
  assert.deepEqual(events.splice(0), [{ newsletterId: nl.id, contactId: contact.id, tagIds: [tag.id], source: 'api' }])
  const got = await (await api('GET', `/newsletters/${nl.id}/contacts/${contact.id}`)).json()
  assert.deepEqual(got.tags.map((x: { name: string }) => x.name), ['new-signup', 'paid'])
  // Bulk through the API keeps its own source; a bad tag and a read-only key write nothing.
  const other = await (await api('POST', `/newsletters/${nl.id}/contacts`, { email: 'second@example.com' })).json()
  assert.equal((await api('POST', `/newsletters/${nl.id}/contacts/bulk`, { contactIds: [other.contact.id], operation: 'tag', tagIds: [tag.id] })).status, 200)
  assert.deepEqual(events.splice(0), [{ newsletterId: nl.id, contactId: other.contact.id, tagIds: [tag.id], source: 'bulk' }])
  const missing = await api('PATCH', `/newsletters/${nl.id}/contacts/${contact.id}`, { addTagIds: ['tag_missing'] })
  assert.deepEqual([missing.status, (await missing.json()).error.code], [404, 'not_found'])
  assert.equal((await api('PATCH', `/newsletters/${nl.id}/contacts/${other.contact.id}`, { addTagIds: [paid.id] }, readKey.secret)).status, 403)
  assert.deepEqual(events.splice(0), [])

  // MCP: the same actions as tools.
  const mcp = async (name: string, args: unknown) => (await (await install.fetch('/mcp', { method: 'POST', headers: { ...apiHeaders(key.secret), accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result
  assert.ok(!(await mcp('contacts_update', { newsletterId: nl.id, contactId: other.contact.id, addTagIds: [paid.id] })).isError)
  assert.deepEqual(events.splice(0), [{ newsletterId: nl.id, contactId: other.contact.id, tagIds: [paid.id], source: 'mcp' }])
  // Sequences are on REST and MCP too.
  const sequence = await api('POST', `/newsletters/${nl.id}/sequences`, { name: 'App onboarding', entry: { type: 'tag', tagId: tag.id }, steps: [{ delayDays: 1, subject: 'Welcome aboard' }] })
  assert.equal(sequence.status, 200)
  const body = await sequence.json()
  assert.deepEqual([body.status, body.entry, body.steps.length], ['draft', { type: 'tag', tagId: tag.id }, 1])
  assert.equal((await (await api('GET', `/newsletters/${nl.id}/sequences`)).json()).sequences.length, 1)
  assert.equal((await api('POST', `/newsletters/${nl.id}/sequences`, { name: 'No', entry: { type: 'manual' } }, readKey.secret)).status, 403)
  const tools = (await (await install.fetch('/mcp', { method: 'POST', headers: { ...apiHeaders(key.secret), accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json()).result.tools as { name: string }[]
  for (const name of ['sequences_list', 'sequences_get', 'sequences_create', 'sequences_update', 'sequences_archive', 'sequences_addStep', 'sequences_updateStep', 'sequences_deleteStep', 'sequences_reorderSteps']) assert.ok(tools.some((tool) => tool.name === name), `missing MCP tool ${name}`)
  assert.ok(!(await mcp('sequences_get', { newsletterId: nl.id, sequenceId: body.id })).isError)
})

test('the sequences module listens to the tag hook and resolves the active tag-entry sequences a new tag starts', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const { owner, nl, ctx } = await setup(install)
  const other = await owner.action('newsletters.create', { name: 'Other' })
  assert.ok(contactTagsListeners().includes(syncContactTags), 'sequences must register syncContactTags with the contacts module')
  assert.equal(contactTagsListeners().filter((l) => l === syncContactTags).length, 1)

  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'new-signup' })
  const paid = await owner.action('tags.create', { newsletterId: nl.id, name: 'paid' })
  const otherTag = await owner.action('tags.create', { newsletterId: other.id, name: 'new-signup' })
  const create = (newsletterId: string, name: string, entry: { type: 'tag'; tagId: string } | { type: 'signup' }) => owner.action('sequences.create', { newsletterId, name, entry })
  const onTag = await create(nl.id, 'On tag', { type: 'tag', tagId: tag.id })
  const draft = await create(nl.id, 'Draft on tag', { type: 'tag', tagId: tag.id })
  const onPaid = await create(nl.id, 'On paid', { type: 'tag', tagId: paid.id })
  const onSignup = await create(nl.id, 'On signup', { type: 'signup' })
  const elsewhere = await create(other.id, 'Elsewhere', { type: 'tag', tagId: otherTag.id })
  const event = (tagIds: string[], newsletterId = nl.id): ContactTagsAdded => ({ newsletterId, contactId: 'ct_x', tagIds, source: 'api' })
  // Nothing can be active through the API yet.
  assert.deepEqual(syncContactTags(ctx, event([tag.id, paid.id])), [])
  // The enrollment unit will activate sequences; force the state it will produce.
  for (const id of [onTag.id, onPaid.id, onSignup.id, elsewhere.id]) ctx.db.run("UPDATE sequences SET status = 'active' WHERE id = ?", id)
  assert.deepEqual(syncContactTags(ctx, event([tag.id])), [{ sequenceId: onTag.id, tagId: tag.id }])
  assert.deepEqual(syncContactTags(ctx, event([paid.id, tag.id])).map((m) => m.sequenceId).sort(), [onTag.id, onPaid.id].sort())
  assert.deepEqual(syncContactTags(ctx, event(['tag_other'])), [])
  assert.deepEqual(syncContactTags(ctx, event([tag.id], other.id)), [], 'a tag id never matches a sequence of another newsletter')
  assert.deepEqual(syncContactTags(ctx, event([otherTag.id], other.id)), [{ sequenceId: elsewhere.id, tagId: otherTag.id }])
  for (const status of ['paused', 'archived']) {
    ctx.db.run('UPDATE sequences SET status = ? WHERE id = ?', status, onTag.id)
    assert.deepEqual(syncContactTags(ctx, event([tag.id])), [])
  }
  assert.ok(!syncContactTags(ctx, event([tag.id])).some((m) => m.sequenceId === draft.id))
  // The hook reads and does not write: tagging through an action with active sequences creates no enrollment yet.
  ctx.db.run("UPDATE sequences SET status = 'active' WHERE id = ?", onTag.id)
  const writes = install.writes()
  const reads = ctx.meter.reads
  syncContactTags(ctx, event([tag.id]))
  assert.equal(install.writes(), writes)
  assert.ok(ctx.meter.reads - reads <= 10, 'the hook must stay one small indexed read')
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com', tags: [tag.id] })
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sequence_enrollments')!.n, 0)
})

test('contact_tags is written only by the contacts tag choke point', () => {
  const root = new URL('../account/', import.meta.url).pathname
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.ts') && /(INSERT[^'"`]*INTO|DELETE\s+FROM|UPDATE)\s+contact_tags/i.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file))
    }
  }
  walk(root)
  assert.deepEqual(offenders, ['contacts/tags.ts'], 'route every tag write through addContactTags / removeContactTags in server/account/contacts/tags.ts')
})
