import { z } from 'zod'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAction, type Actor } from '../core/actions.ts'
import { notify, notificationKinds, notificationTones, EMAIL_COOLDOWN } from '../account/notifications/index.ts'
import { raiseAdminAlert } from '../control/admin/index.ts'
import { createInstall } from './harness.ts'
import { createIssue, drive, sendableInstall, addContacts } from './sending-setup.ts'

test('every notification kind has an explicit tone', () => {
  assert.deepEqual(Object.keys(notificationTones).sort(), [...notificationKinds].sort())
  for (const kind of notificationKinds) assert.ok(['info', 'ok', 'warn', 'danger'].includes(notificationTones[kind]))
})

for (const cloud of [false, true]) test(`notification storms email once per kind per six hours across restart (${cloud ? 'cloud' : 'self-hosted'})`, async () => {
  let install = await createInstall({ cloud })
  try {
    let owner = await install.signUp({ email: 'owner@example.com' })
    await owner.action('newsletters.create', { name: 'Alerts' })
    const accountId = owner.accountId!
    const ctx = install.app.account(accountId).ctx
    for (let i = 0; i < 100; i++) notify(ctx, { kind: 'campaign_paused', title: 'Campaign paused', body: 'Check sending.', href: '/campaigns' })
    await install.runJobs()
    assert.equal(install.outbox(accountId).filter((r) => r.kind === 'system').length, 1)
    assert.equal((await owner.action('notifications.list', {})).unread, 100)
    install.clock.advance(EMAIL_COOLDOWN - 1)
    install = await install.restart()
    owner = await install.signIn('owner@example.com', 'correct horse battery')
    const restarted = install.app.account(accountId).ctx
    notify(restarted, { kind: 'campaign_paused', title: 'Still paused' })
    await install.runJobs()
    assert.equal(install.outbox(accountId).filter((r) => r.kind === 'system').length, 1)
    install.clock.advance(1)
    notify(restarted, { kind: 'campaign_paused', title: 'Paused again', body: '<script>alert(1)</script>', href: '//example.com' })
    await install.runJobs()
    const emails = install.outbox(accountId).filter((r) => r.kind === 'system')
    assert.equal(emails.length, 2)
    assert.match(emails[1].html, /&lt;script&gt;/)
    assert.doesNotMatch(emails[1].html, /<script>/)
    assert.match(emails[1].text, /http:\/\/app.example.com\/$/)
    notify(restarted, { kind: 'campaign_sent', title: 'Sent' })
    notify(restarted, { kind: 'invite_accepted', title: 'Accepted' })
    await install.runJobs()
    assert.equal(install.outbox(accountId).filter((r) => r.kind === 'system').length, 2, 'routine updates remain in-app')
  } finally { install.close() }
})

test('notifications and read receipts are private to each user, including legacy owner alerts', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Private' })
  const ctx = install.app.account(owner.accountId!).ctx
  const actor: Actor = { userId: 'usr_member', email: 'member@example.com', owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
  const ownerId = notify(ctx, { kind: 'account_blocked', title: 'Blocked' })
  const memberId = notify(ctx, { kind: 'invite_accepted', title: 'Welcome', userId: actor.userId })
  ctx.db.run("INSERT INTO notifications (id, kind, tone, title, body, href, created_at) VALUES ('ntf_legacy', 'campaign_sent', 'ok', 'Legacy owner alert', '', '/', ?)", ctx.now())
  const listSchema = z.object({ unread: z.number(), items: z.array(z.object({ id: z.string() })) })
  const listed = listSchema.parse(await runAction(ctx, 'notifications.list', {}, actor))
  assert.deepEqual(listed.items.map((r) => r.id), [memberId])
  assert.equal(listed.unread, 1)
  await runAction(ctx, 'notifications.markRead', { ids: [ownerId, 'ntf_legacy', memberId] }, actor)
  assert.equal(listSchema.parse(await runAction(ctx, 'notifications.list', {}, actor)).unread, 0)
  assert.equal((await owner.action('notifications.list', {})).unread, 2)
  await owner.action('notifications.markRead', { ids: [ownerId] })
  await owner.action('notifications.markRead', { ids: [ownerId] })
  assert.equal((await owner.action('notifications.list', {})).unread, 1)
  await assert.rejects(runAction(ctx, 'notifications.markRead', { ids: [memberId] }, { ...actor, access: 'read' }), { status: 403 })
  await assert.rejects(runAction(ctx, 'notifications.list', {}, { ...actor, grants: {} }), { status: 403 })
})

test('admin alert storms send one email, preserve the alert list and resume after the cooldown', async (t) => {
  const install = await createInstall({ env: { ADMIN_EMAILS: 'admin@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const ctx = install.app.control.ctx
  for (let i = 0; i < 100; i++) raiseAdminAlert(ctx, { kind: 'provider_refusing', title: 'Provider refused sends', body: 'Check configuration.' })
  await install.runJobs()
  assert.equal(install.outbox().filter((r) => r.kind === 'system').length, 1)
  const alerts = await owner.action('admin.alerts', {})
  assert.equal(alerts.length, 100)
  await owner.action('admin.resolveAlert', { alertId: alerts[0].id })
  assert.equal((await owner.action('admin.alerts', { resolved: true })).length, 1)
  install.clock.advance(EMAIL_COOLDOWN)
  raiseAdminAlert(ctx, { kind: 'provider_refusing', title: 'Provider still refuses sends' })
  await install.runJobs()
  assert.equal(install.outbox().filter((r) => r.kind === 'system').length, 2)
})

test('dead jobs and invalid webhook signatures produce emailed admin alerts', async (t) => {
  const install = await createInstall({ env: { ADMIN_EMAILS: 'admin@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const ctx = install.app.account(owner.accountId!).ctx
  const job = ctx.jobs.enqueue('missing.handler')
  ctx.db.run('UPDATE jobs SET attempts = 7 WHERE id = ?', job.id)
  await install.runJobs()
  assert.ok((await owner.action('admin.alerts', {})).some((r) => r.kind === 'job_dead'))
  assert.equal((await install.fetch('/hooks/resend', { method: 'POST', body: '{}' })).status, 400)
  await install.runJobs()
  assert.ok((await owner.action('admin.alerts', {})).some((r) => r.kind === 'webhook_verification'))
  assert.equal(install.outbox().filter((r) => r.kind === 'system').length, 2)
})

test('completed imports notify once and campaign sends use the shared notification function', async (t) => {
  const { install, owner, nl, ctx } = await sendableInstall()
  t.after(() => install.close())
  ctx.db.run("INSERT INTO imports (id, newsletter_id, status, added, created_by, created_at) VALUES ('imp_finished', ?, 'done', 10, ?, ?)", nl.id, owner.session.user.id, ctx.now())
  addContacts(ctx, nl.id, 2)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id })
  await drive(install, owner, issue.id)
  const first = await owner.action('notifications.list', {})
  assert.equal(first.items.filter((r) => r.kind === 'import_finished').length, 1)
  assert.equal(first.items.filter((r) => r.kind === 'campaign_sent').length, 1)
  assert.equal(first.items.filter((r) => r.kind === 'domain_verified').length, 1)
  install.clock.advance(61_000)
  await install.runJobs()
  assert.equal((await owner.action('notifications.list', {})).items.filter((r) => r.kind === 'import_finished').length, 1)
})

test('control-forwarded notifications are idempotent across duplicate RPC delivery', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const account = install.app.stores.account(owner.accountId!)
  const input = { eventId: 'invite-accepted-1', notification: { kind: 'invite_accepted' as const, title: 'Invitation accepted', href: '/settings/team' } }
  assert.deepEqual(await account.receiveNotification(input), await account.receiveNotification(input))
  assert.equal((await owner.action('notifications.list', {})).items.length, 1)
})


test('notification cursors retain every row during a same-millisecond alert storm', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const ctx = install.app.account(owner.accountId!).ctx
  for (let i = 0; i < 120; i++) notify(ctx, { kind: 'campaign_sent', title: `Issue ${i}` })
  const seen = new Set<string>()
  let cursor: { before: number; beforeId: string } | undefined
  for (let i = 0; i < 3; i++) {
    const page = await owner.action('notifications.list', cursor ?? {})
    for (const row of page.items) { assert.ok(!seen.has(row.id)); seen.add(row.id) }
    const last = page.items.at(-1)!
    cursor = { before: last.created_at, beforeId: last.id }
  }
  assert.equal(seen.size, 120)
})

test('plan-limit and blocked-policy notifications fire once on the real state change', async (t) => {
  const install = await createInstall({ cloud: true })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Limits' })
  const account = install.app.stores.account(owner.accountId!)
  const policy = { version: 100, status: 'active' as const, plan: 'test', limits: { maxContacts: 10, maxEmailsPerMonth: 10, maxNewsletters: 10, maxTeamPerNewsletter: 5 } }
  await account.applyPolicy(policy)
  const ctx = install.app.account(owner.accountId!).ctx
  addContacts(ctx, nl.id, 9)
  assert.equal((await owner.action('notifications.list', {})).items.filter((r) => r.kind === 'plan_limit_near').length, 1)
  addContacts(ctx, nl.id, 1, 'last')
  assert.equal((await owner.action('notifications.list', {})).items.filter((r) => r.kind === 'plan_limit_near').length, 1)
  await account.applyPolicy({ ...policy, version: 101, status: 'blocked' })
  await account.applyPolicy({ ...policy, version: 101, status: 'blocked' })
  assert.equal((await owner.action('notifications.list', {})).items.filter((r) => r.kind === 'account_blocked').length, 1)
})
