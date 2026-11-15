import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall } from './harness.ts'
import { compileFilter, audienceQuery, type Filter } from '../account/segments/index.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'

const conditions: [string, Filter, string[]][] = [
  ['status', { field: 'status', in: ['subscribed'] }, ['a', 'b']],
  ['empty status', { field: 'status', in: [] }, []],
  ['source', { field: 'source', in: ['import'] }, ['b']],
  ['provider', { field: 'provider', in: ['gmail'] }, ['a']],
  ['email contains', { field: 'email', op: 'contains', value: 'a@' }, ['a']],
  ['email ends with', { field: 'email', op: 'endsWith', value: 'EXAMPLE.COM' }, ['a', 'b', 'c']],
  ['email literal wildcard', { field: 'email', op: 'contains', value: '%' }, []],
  ['custom eq', { field: 'custom', key: 'city', op: 'eq', value: 'Paris' }, ['a']],
  ['custom neq', { field: 'custom', key: 'city', op: 'neq', value: 'Paris' }, ['b']],
  ['custom contains', { field: 'custom', key: 'city', op: 'contains', value: 'ari' }, ['a']],
  ['custom gt', { field: 'custom', key: 'score', op: 'gt', value: 5 }, ['a']],
  ['custom lt', { field: 'custom', key: 'score', op: 'lt', value: 5 }, ['b']],
  ['custom set', { field: 'custom', key: 'city', op: 'set' }, ['a', 'b']],
  ['custom unset', { field: 'custom', key: 'city', op: 'unset' }, ['c']],
  ['custom boolean', { field: 'custom', key: 'paid', op: 'eq', value: true }, ['a']],
  ['all', { all: [{ field: 'status', in: ['subscribed'] }, { field: 'source', in: ['import'] }] }, ['b']],
  ['any', { any: [{ field: 'source', in: ['import'] }, { field: 'status', in: ['cleaned'] }] }, ['b', 'c']],
  ['not', { not: { field: 'custom', key: 'city', op: 'contains', value: 'ari' } }, ['b', 'c']],
  ['empty all', { all: [] }, ['a', 'b', 'c']],
  ['empty any', { any: [] }, []],
  ['engagement opened', { field: 'engagement', op: 'openedLast', issues: 2 }, ['a']],
  ['engagement clicked', { field: 'engagement', op: 'clickedLast', issues: 2 }, ['b']],
  ['engagement ignored', { field: 'engagement', op: 'ignoredLast', issues: 2 }, ['c']],
]

test('every filter condition selects the right contacts through actions', async () => {
  const install = await createInstall()
  try {
    install.clock.set(Date.now())
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Filter tests' })
    const second = await owner.action('newsletters.create', { name: 'Other list' })
    const ctx = install.app.account(owner.accountId!).ctx
    const now = install.clock.now()
    for (const [id, status, source, fields, provider, time] of [
      ['a', 'subscribed', 'manual', '{"city":"Paris","score":10,"paid":true}', 'gmail', now - 86400000],
      ['b', 'subscribed', 'import', '{"city":"London","score":2,"paid":false}', 'other', now - 30 * 86400000],
      ['c', 'cleaned', 'signup', '{}', 'other', null],
    ] as const) ctx.db.run('INSERT INTO contacts (id, newsletter_id, email, status, source, fields, provider, subscribed_at, last_opened_at, last_clicked_at, last_sent_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, nl.id, id + '@example.com', status, source, fields, provider, time, time, time, time, now, now)
    ctx.db.run("INSERT INTO contacts (id, newsletter_id, email, created_at, updated_at) VALUES ('foreign', ?, 'foreign@example.com', ?, ?)", second.id, now, now)
    const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'Tagged' })
    await owner.action('contacts.bulk', { newsletterId: nl.id, contactIds: ['a'], operation: 'tag', tagIds: [tag.id] })
    const cases: typeof conditions = [...conditions, ['tag', { field: 'tag', id: tag.id }, ['a']], ['tag none', { not: { field: 'tag', id: tag.id } }, ['b', 'c']], ['tags all', { all: [{ field: 'tag', id: tag.id }, { field: 'status', in: ['subscribed'] }] }, ['a']]]
    for (const field of ['subscribedAt', 'lastOpenedAt', 'lastClickedAt', 'lastSentAt'] as const) {
      cases.push([field + ' before', { field, op: 'before', value: now - 7 * 86400000 }, ['b']], [field + ' after', { field, op: 'after', value: now - 7 * 86400000 }, ['a']], [field + ' withinDays', { field, op: 'withinDays', value: 7 }, ['a']], [field + ' never', { field, op: 'never' }, ['c']])
    }
    for (const [index, at] of [now - 1000, now - 2000, now - 3000].entries()) {
      ctx.db.run("INSERT INTO campaigns (id, newsletter_id, subject, status, sent_at, created_by, created_at, updated_at) VALUES (?, ?, '', 'sent', ?, '', ?, ?)", 'issue' + index, nl.id, at, now, now)
      for (const id of ['a', 'b', 'c']) ctx.db.run('INSERT INTO deliveries (campaign_id, contact_id, email, status, sent_at, opened_at, clicked_at, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'issue' + index, id, id + '@example.com', 'sent', now, id === 'a' ? now : null, id === 'b' ? now : null, now)
    }
    for (const [name, filter, expected] of cases) {
      const q = compileFilter(filter, nl.id)
      assert.deepEqual(ctx.db.all<{ id: string }>(`SELECT c.id FROM contacts c WHERE ${q.where} ORDER BY c.id`, ...q.params).map((r) => r.id), expected, name + ' compiler')
      const count = await owner.action('segments.count', { newsletterId: nl.id, filter })
      assert.equal(count.count, expected.length, name + ' action count')
    }
    // An older open cannot qualify as an open in the last issue.
    ctx.db.run("UPDATE deliveries SET opened_at = NULL WHERE contact_id = 'a' AND campaign_id IN ('issue0', 'issue1')")
    assert.equal((await owner.action('segments.count', { newsletterId: nl.id, filter: { field: 'engagement', op: 'openedLast', issues: 2 } })).count, 0)
    const saved = await owner.action('segments.create', { newsletterId: nl.id, name: 'Imported', filter: { field: 'source', in: ['import'] } })
    assert.equal((await owner.action('segments.list', { newsletterId: nl.id })).segments[0].id, saved.id)
    await owner.action('segments.update', { newsletterId: nl.id, segmentId: saved.id, name: 'Everyone', filter: { all: [] } })
    ctx.db.run("INSERT INTO suppressions (id, email, reason, created_at) VALUES ('s', 'b@example.com', 'manual', ?)", now)
    let q = audienceQuery(ctx, nl.id, { segmentId: saved.id })
    assert.deepEqual(ctx.db.all<{ id: string }>(`SELECT c.id FROM contacts c WHERE ${q.where}`, ...q.params).map((r) => r.id), ['a'])
    q = audienceQuery(ctx, nl.id, { tagIds: [tag.id], exclude: { tagIds: [tag.id] } })
    assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${q.where}`, ...q.params)!.n, 0)
    const actor: Actor = { userId: 'member', email: 'member@example.com', owner: false, grants: { [second.id]: 'admin' }, access: 'full', via: 'web', installAdmin: false }
    await assert.rejects(runAction(ctx, 'segments.update', { newsletterId: second.id, segmentId: saved.id, name: 'No', filter: { all: [] } }, actor), (e: unknown) => e instanceof AppError && e.status === 404)
    await owner.action('segments.delete', { newsletterId: nl.id, segmentId: saved.id })
    assert.equal((await owner.action('segments.list', { newsletterId: nl.id })).segments.length, 0)
    assert.throws(() => compileFilter({ field: 'custom', key: 'score', op: 'gt' }, nl.id), AppError)
    assert.throws(() => compileFilter({ all: Array.from({ length: 100 }, () => ({ field: 'status', in: ['subscribed'] })) }, nl.id), AppError)
    assert.throws(() => compileFilter({ field: 'custom', key: 'x") OR 1=1--', op: 'eq', value: 1 }, nl.id), AppError)
  } finally { install.close() }
})

test('50,000 contact paging and segment counts use indexes within a generous one-second bound', async () => {
  const install = await createInstall()
  try {
    install.clock.set(Date.now())
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Large list' })
    const ctx = install.app.account(owner.accountId!).ctx
    ctx.db.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 50000)
      INSERT INTO contacts (id, newsletter_id, email, status, created_at, updated_at)
      SELECT printf('c%06d', x), ?, printf('reader%06d@example.com', x), 'subscribed', x, x FROM n`, nl.id)
    const q = compileFilter({ field: 'status', in: ['subscribed'] }, nl.id)
    const plan = ctx.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM contacts c WHERE ${q.where}`, ...q.params)
    assert.ok(plan.some((r) => /USING COVERING INDEX contacts_status/.test(r.detail)), JSON.stringify(plan))
    const pagePlan = ctx.db.all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT * FROM contacts c WHERE c.newsletter_id = ? AND (c.created_at, c.id) < (?, ?) ORDER BY c.created_at DESC, c.id DESC LIMIT 51', nl.id, 49950, 'c049950')
    assert.ok(pagePlan.some((r) => /USING INDEX contacts_created_page/.test(r.detail)), JSON.stringify(pagePlan))
    assert.ok(!pagePlan.some((r) => /TEMP B-TREE|SCAN c/.test(r.detail)))
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      const page = await owner.action('contacts.list', { newsletterId: nl.id, limit: 50 })
      assert.equal(page.contacts.length, 50)
      assert.equal(page.contacts[0].email, 'reader050000@example.com')
      const next = await owner.action('contacts.list', { newsletterId: nl.id, limit: 50, cursor: page.nextCursor! })
      assert.equal(next.contacts[0].email, 'reader049950@example.com')
      const count = await owner.action('segments.count', { newsletterId: nl.id, filter: { field: 'status', in: ['subscribed'] } })
      assert.equal(count.count, 50000)
      assert.ok(performance.now() - start < 1000, 'Two real HTTP list pages and a segment count must finish within one second')
    }
  } finally { install.close() }
})
