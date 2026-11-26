import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountRegistry } from '../account/modules.ts'
import { controlRegistry } from '../control/modules.ts'
import { runAction, type Actor, type AnyAction } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import type { Db } from '../core/db.ts'
import { transitionCampaign } from '../account/campaigns/index.ts'
import { notify } from '../account/notifications/index.ts'
import { createInstall, type Client, type Install } from './harness.ts'

// Walks the whole registry. For every id-shaped input it swaps in an id that belongs to another
// newsletter of the same account, or to another account. The call must fail with a 403 or 404, or
// be a no-op: no write anywhere and no trace of the other tenant's data in its output.

type Ids = Record<string, string>
const ID_KEY = /(^id$|Id$|Ids$|^ids$)/
const VOLATILE = new Set(['rate_limits', '_migrations'])

function snapshot(db: Db): string {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  return JSON.stringify(tables.filter((t) => !VOLATILE.has(t.name)).map((t) => [t.name, db.all(`SELECT * FROM "${t.name}"`).map((row) => JSON.stringify(row)).sort()]))
}

async function newsletterFixtures(install: Install, client: Client, label: string): Promise<Ids> {
  const nl = await client.action('newsletters.create', { name: `Newsletter ${label}` })
  const ctx = install.app.account(client.accountId!).ctx
  const campaign = await client.action('campaigns.create', { newsletterId: nl.id, subject: `Draft ${label}` })
  const sent = await client.action('campaigns.create', { newsletterId: nl.id, subject: `Sent ${label}` })
  transitionCampaign(ctx, sent.id, 'scheduled', { scheduledAt: ctx.now() + 1000 })
  transitionCampaign(ctx, sent.id, 'sending')
  transitionCampaign(ctx, sent.id, 'sent')
  const contact = await client.action('contacts.create', { newsletterId: nl.id, email: `reader-${label}@example.com` })
  const segment = await client.action('segments.create', { newsletterId: nl.id, name: `Segment ${label}`, filter: { field: 'status', in: ['subscribed'] } })
  const author = await client.action('authors.create', { newsletterId: nl.id, name: `Writer ${label}`, slug: `writer-${label}` })
  const tag = await client.action('tags.create', { newsletterId: nl.id, name: `Tag ${label}` })
  await client.action('contacts.bulk', { newsletterId: nl.id, contactIds: [contact.contact.id], operation: 'tag', tagIds: [tag.id] })
  const field = await client.action('contactFields.create', { newsletterId: nl.id, key: `custom_${label}`, label: 'Custom', type: 'text' })
  const imp = await client.action('imports.create', { newsletterId: nl.id, mapping: { email: 'email' } } as never) as { id: string }
  const post = await client.action('website.publishPost', { newsletterId: nl.id, subject: `Post ${label}`, slug: `post-${label}`, source: 'Body', visible: false })
  const sequence = await client.action('sequences.create', { newsletterId: nl.id, name: `Sequence ${label}`, entry: { type: 'tag', tagId: tag.id }, exit: { tagIds: [tag.id], segmentId: segment.id }, steps: [{ delayDays: 1, subject: `Step ${label}` }] })
  return { sequenceId: sequence.id, stepId: sequence.steps[0].id, theme: JSON.stringify(nl.theme), revision: String(campaign.revision), newsletterId: nl.id, campaignId: campaign.id, sentCampaignId: sent.id, contactId: contact.contact.id, segmentId: segment.id, authorId: author.id, tagId: tag.id, fieldId: field.id, importId: imp.id, postId: post.id }
}

async function accountFixtures(install: Install, client: Client, label: string): Promise<Ids> {
  const ctx = install.app.account(client.accountId!).ctx
  const domain = await client.action('domains.add', { name: `${label}.example.com` })
  const key = await client.action('apikeys.create', { name: `Key ${label}`, access: 'full' })
  await client.action('suppressions.add', { accountId: client.accountId!, email: `blocked-${label}@example.com` })
  const suppression = ctx.db.get<{ id: string }>('SELECT id FROM suppressions WHERE email = ?', `blocked-${label}@example.com`)!
  notify(ctx, { kind: 'import_finished', title: `Owner notice ${label}` })
  const notification = ctx.db.get<{ id: string }>('SELECT id FROM notifications ORDER BY created_at DESC LIMIT 1')!
  return { accountId: client.accountId!, domainId: domain.id, keyId: key.id, suppressionId: suppression.id, notificationId: notification.id, sessionId: client.session.user.id }
}

/** A valid input for `action` that names only the attacker's own resources. */
function baseInput(action: AnyAction, own: Ids, extra: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {
    ...own,
    campaignId: action.name === 'website.updateIssue' || action.name.startsWith('stats.') ? own.sentCampaignId : own.campaignId,
    name: 'isolation.example.com', slug: 'isolation-slug', role: 'member', email: 'invitee@example.com',
    key: 'iso_key', label: 'Label', type: 'text', filter: { all: [{ field: 'tag', id: own.tagId }, { field: 'status', in: ['subscribed'] }] },
    contactIds: [own.contactId], tagIds: [own.tagId], ids: [own.notificationId], operation: 'tag',
    data: 'iVBORw0KGgo=', contentType: 'image/png', kind: 'logo', width: 1, height: 1,
    confirmation: 'RESUME', plan: 'starter', interval: 'monthly', access: 'full', reason: 'Test reason',
    subject: 'Subject', source: 'Body', visible: false, settings: {},
    audience: { segmentId: own.segmentId, exclude: { segmentIds: [own.segmentId], tagIds: [own.tagId] } },
    scheduledAt: Date.UTC(2027, 0, 1), theme: own.theme ? JSON.parse(own.theme) : undefined, revision: own.revision ? Number(own.revision) : undefined,
    options: { tagIds: [own.tagId] }, mapping: { email: 'email' }, seq: 0, rows: [{ email: 'row@example.com' }], totalRows: 1,
    to: ['test@example.com'], hostname: '', enabled: true, doubleOptIn: true,
    addTagIds: [own.tagId], entry: { type: 'tag', tagId: own.tagId }, exit: { tagIds: [own.tagId], segmentId: own.segmentId }, stepIds: [own.stepId], delayDays: 2, ...extra,
  }
  if (action.name === 'website.publishPost') input.slug = 'isolation-post'
  if (action.name === 'newsletters.update') delete input.domainId
  if (action.name === 'signup.saveWelcome') input.revision = null
  if (action.name === 'account.delete' || action.name === 'admin.deleteAccount') input.confirmation = 'DELETE'
  if (action.name === 'admin.deadJobs') input.operation = 'list'
  if (action.name === 'imports.create') delete input.options
  const parsed = action.input.safeParse(input)
  if (!parsed.success) return input
  return prune(input, parsed.data) as Record<string, unknown>
}

/** Keeps only what the schema keeps, so a substituted id is one the action actually reads. */
function prune(raw: unknown, parsed: unknown): unknown {
  if (Array.isArray(raw) && Array.isArray(parsed)) return raw.map((v, i) => prune(v, parsed[i]))
  if (raw && typeof raw === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw).filter(([k]) => k in parsed).map(([k, v]) => [k, prune(v, (parsed as Record<string, unknown>)[k])]))
  }
  return raw
}

/** Every path to an id inside the input, with the fixture key it maps to. */
function idPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  // Tag ids inside a filter only ever match tags of the filtered newsletter; checked separately below.
  if (path[0] === 'filter') return []
  const parent = path[path.length - 1]
  if (Array.isArray(value)) return value.flatMap((v, i) => (typeof v === 'string' && typeof parent === 'string' && ID_KEY.test(parent) ? [[...path, i]] : idPaths(v, [...path, i])))
  if (value && typeof value === 'object') {
    return [...Object.entries(value).flatMap(([k, v]) => (ID_KEY.test(k) && typeof v === 'string' ? [[...path, k]] : idPaths(v, [...path, k])))]
  }
  return []
}

function fixtureKey(path: (string | number)[]): string {
  const names = path.filter((p): p is string => typeof p === 'string')
  const last = names[names.length - 1]
  if (last === 'ids') return 'notificationId'
  if (last === 'addTagIds' || last === 'removeTagIds') return 'tagId'
  return last.endsWith('Ids') ? last.slice(0, -1) : last
}

function substitute(input: Record<string, unknown>, path: (string | number)[], value: string): Record<string, unknown> {
  const copy = structuredClone(input)
  let at: any = copy
  for (const step of path.slice(0, -1)) at = at[step]
  at[path[path.length - 1]] = value
  return copy
}

const actions = [...accountRegistry.actions.values(), ...controlRegistry.actions.values()]

test('no action reaches a resource of another newsletter or another account through any id input', async () => {
  const install = await createInstall({ cloud: true })
  const failures: string[] = []
  const tried = new Set<string>()
  const attempts: string[] = []
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const other = await install.signUp({ email: 'other@example.com' })
    const attackerClient = await install.signUp({ email: 'attacker@example.com' })
    const control = install.app.control.ctx
    const { pushPolicy } = await import('../control/accounts/index.ts')
    for (const c of [owner, other]) pushPolicy(control, c.accountId!, { plan: 'pro' })
    await install.runJobs()
    const victimNl = await newsletterFixtures(install, owner, 'victim')
    const ownNl = await newsletterFixtures(install, owner, 'own')
    const foreignNl = await newsletterFixtures(install, other, 'foreign')
    const ownAccount = await accountFixtures(install, owner, 'own')
    const foreignAccount = await accountFixtures(install, other, 'foreign')
    await owner.action('team.invite', { accountId: owner.accountId!, newsletterId: ownNl.newsletterId, email: 'pending@example.com', role: 'member' })
    await other.action('team.invite', { accountId: other.accountId!, newsletterId: foreignNl.newsletterId, email: 'pending-foreign@example.com', role: 'member' })
    const inviteOf = (accountId: string) => control.db.get<{ id: string }>('SELECT id FROM invites WHERE account_id = ?', accountId)!.id
    control.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, ?, ?, ?)', attackerClient.session.user.id, owner.accountId!, ownNl.newsletterId, 'admin', install.clock.now())
    await install.runJobs()

    const accountCtx = install.app.account(owner.accountId!).ctx
    const attacker: Actor = { userId: attackerClient.session.user.id, email: attackerClient.email, owner: false, grants: { [ownNl.newsletterId]: 'admin' }, access: 'full', via: 'web', installAdmin: false }
    const ownerActor: Actor = { userId: owner.session.user.id, email: owner.email, owner: true, grants: {}, access: 'full', via: 'web', installAdmin: false }
    const otherActor: Actor = { ...ownerActor, userId: other.session.user.id, email: other.email }
    const victimSessions = control.db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ?', owner.session.user.id)

    const secrets = (ids: Ids, label: string) => [...Object.entries(ids).filter(([k]) => !['accountId', 'sessionId', 'theme', 'revision'].includes(k)).map(([, v]) => v), `reader-${label}@example.com`, `Draft ${label}`, `Writer ${label}`, `Tag ${label}`, `Sequence ${label}`, `Step ${label}`, `blocked-${label}@example.com`]
    const attempt = async (label: string, ctx: typeof accountCtx, action: AnyAction, input: Record<string, unknown>, actor: Actor, watched: Db[], forbidden: string[], substituted: string) => {
      if (!action.input.safeParse(input).success) return
      tried.add(action.name)
      attempts.push(label)
      const before = watched.map(snapshot)
      let outcome: string
      let output = ''
      try {
        output = JSON.stringify(await runAction(ctx, action.name, input, actor)) ?? ''
        outcome = 'allowed'
      } catch (error) {
        outcome = error instanceof AppError ? `${error.status} ${error.code}` : `crash ${String(error)}`
      }
      const changed = watched.some((db, i) => snapshot(db) !== before[i])
      const leaked = forbidden.filter((value) => value !== substituted && output.includes(value))
      if ((outcome !== 'allowed' && !/^40[34] /.test(outcome)) || changed || leaked.length) failures.push(`${label} ${action.name}: ${outcome}${changed ? ' and changed state' : ''}${leaked.length ? ` and returned ${leaked.join(', ')}` : ''}`)
    }

    for (const action of actions) {
      if (action.scope === 'account') {
        // Same account: an admin of one newsletter names the other newsletter's ids.
        const input = baseInput(action, { ...ownNl, ...ownAccount }, {})
        for (const path of idPaths(input)) {
          const key = fixtureKey(path)
          const foreign = key === 'campaignId' && input.campaignId === ownNl.sentCampaignId ? victimNl.sentCampaignId : key === 'notificationId' ? ownAccount.notificationId : victimNl[key]
          if (!foreign) continue
          await attempt(`newsletter ${path.join('.')}`, accountCtx, action, substitute(input, path, foreign), attacker, [accountCtx.db, control.db], [...secrets(victimNl, 'victim'), 'Owner notice own'], foreign)
        }
        // The owner may act on both newsletters, but a secondary id must still match the named newsletter.
        for (const path of idPaths(input)) {
          const key = fixtureKey(path)
          if (key === 'newsletterId' || key === 'accountId' || !victimNl[key] || !input.newsletterId) continue
          const foreign = key === 'campaignId' && input.campaignId === ownNl.sentCampaignId ? victimNl.sentCampaignId : victimNl[key]
          await attempt(`owner mismatch ${path.join('.')}`, accountCtx, action, substitute(input, path, foreign), ownerActor, [accountCtx.db, control.db], [], foreign)
        }
        // Another account: its owner names this account's ids in its own store.
        const otherCtx = install.app.account(other.accountId!).ctx
        const otherInput = baseInput(action, { ...foreignNl, ...foreignAccount }, {})
        for (const path of idPaths(otherInput)) {
          const key = fixtureKey(path)
          const foreign = key === 'campaignId' && otherInput.campaignId === foreignNl.sentCampaignId ? ownNl.sentCampaignId : { ...ownNl, ...ownAccount }[key]
          if (!foreign) continue
          await attempt(`account ${path.join('.')}`, otherCtx, action, substitute(otherInput, path, foreign), otherActor, [accountCtx.db, control.db], secrets({ ...ownNl, ...ownAccount }, 'own'), foreign)
        }
      } else {
        const input = baseInput(action, { ...foreignNl, ...foreignAccount, inviteId: inviteOf(other.accountId!), userId: other.session.user.id }, { sessionId: 'none', token: 'none', currentPassword: 'correct horse battery', newPassword: 'another correct password' })
        const victim: Ids = { ...ownNl, ...ownAccount, inviteId: inviteOf(owner.accountId!), userId: attacker.userId, sessionId: victimSessions[0]?.id ?? '', alertId: 'alert_none', jobId: 'job_none' }
        for (const path of idPaths(input)) {
          const key = fixtureKey(path)
          if (!victim[key]) continue
          await attempt(`control ${path.join('.')}`, control, action, substitute(input, path, victim[key]), otherActor, [control.db, accountCtx.db], secrets(victim, 'own'), victim[key])
        }
      }
    }

    const notices = await runAction(accountCtx, 'notifications.list', {}, attacker)
    assert.ok(!JSON.stringify(notices).includes('Owner notice own'), 'a teammate must not see the owner notifications')
    const foreignTag = { all: [{ field: 'tag', id: victimNl.tagId }] }
    const count = await runAction(accountCtx, 'segments.count', { newsletterId: ownNl.newsletterId, filter: foreignTag }, attacker) as { count: number }
    assert.equal(count.count, 0)
    const listed = await runAction(accountCtx, 'contacts.list', { newsletterId: ownNl.newsletterId, filter: foreignTag }, ownerActor) as { contacts: unknown[] }
    assert.equal(listed.contacts.length, 0)
  } finally {
    install.close()
  }
  assert.deepEqual(failures, [])
  assert.ok(attempts.length > 250, 'the walk must reach every id-shaped input')
  for (const name of ['contacts.bulk', 'contacts.update', 'sequences.create', 'sequences.get', 'sequences.update', 'sequences.updateStep', 'sequences.deleteStep', 'sequences.reorderSteps', 'sequences.activate', 'sequences.pause', 'sequences.resume', 'sequences.enroll', 'sequences.exit', 'sequences.pauseEnrollment', 'sequences.resumeEnrollment', 'sequences.listEnrollments', 'sequences.stats', 'campaigns.create', 'campaigns.update', 'notifications.markRead', 'website.publishPost', 'team.remove', 'billing.portal']) assert.ok(tried.has(name), `${name} was not walked`)
})

test('the edge drops smuggled x-mc headers on every route', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    await owner.action('website.update', { newsletterId: nl.id, settings: { enabled: true } as never })
    await install.runJobs()
    const smuggled = { 'x-mc-site': nl.id, 'X-MC-Host': 'app.example.com', 'x-mc-account': owner.accountId!, 'x-mc-ip': '192.0.2.1', 'x-mc-actor': 'forged' }
    const pixel = await install.fetch(`/t/o/${owner.accountId}.o.AAAA.AAAA`, { headers: smuggled })
    assert.equal(pixel.headers.get('content-type'), 'image/gif', 'a token route must not turn into a website page')
    const page = await install.fetch('/n/weekly', { headers: smuggled })
    assert.equal(page.status, 200)
    const action = await install.fetch('/api/actions/newsletters.list', { method: 'POST', headers: { ...smuggled, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(action.status, 401)
  } finally {
    install.close()
  }
})
