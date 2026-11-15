import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import type { PermissionEntries } from './permission-types.ts'
import { test } from 'node:test'
import { accountRegistry } from '../account/modules.ts'
import { controlRegistry } from '../control/modules.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import { sha256Hex } from '../core/crypto.ts'
import { createInstall } from './harness.ts'

const matrix: PermissionEntries = {}
const directory = new URL('./permissions/', import.meta.url)
for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts')).sort()) {
  const { entries }: { entries: PermissionEntries } = await import(new URL(file, directory).href)
  for (const [name, entry] of Object.entries(entries)) {
    assert.ok(!(name in matrix), `Duplicate permission matrix entry: ${name} (${file})`)
    matrix[name] = entry
  }
}

const actions = [...accountRegistry.actions.values(), ...controlRegistry.actions.values()]

test('permission matrix covers the entire registry; add one explicit entry per new action', () => {
  const missing = actions.map((a) => a.name).filter((name) => !(name in matrix))
  const stale = Object.keys(matrix).filter((name) => !actions.some((a) => a.name === name))
  assert.deepEqual(missing, [], `Missing permission matrix entries: ${missing.join(', ')}. Add entries to server/test/permissions/<module>.ts with a valid input fixture if needed.`)
  assert.deepEqual(stale, [], `Remove stale permission matrix entries: ${stale.join(', ')}`)
})

for (const action of actions) test(`permission matrix: ${action.name}`, async () => {
  assert.ok(action.name in matrix, `Missing permission matrix entry for ${action.name}`)
  const { role: expected, input: fixture, error: expectedError } = matrix[action.name]
  const metadataRole = action.scope === 'control' && (expected === 'owner' || expected === 'teammate') ? 'user' : expected
  assert.equal(action.role, metadataRole, `${action.name}: minimum role differs from the reviewed matrix`)
  const install = await createInstall({ cloud: true })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    install.app.control.ctx.db.run('UPDATE accounts SET plan = ? WHERE id = ?', 'pro', owner.accountId!)
    const nl = await owner.action('newsletters.create', { name: 'Matrix newsletter' })
    for (const grant of ['member', 'admin', 'outsider'] as const) {
      const client = await install.signUp({ email: `${grant}@example.com` })
      const control = install.app.control.ctx
      if (grant !== 'outsider') control.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, ?, ?, ?)', client.session.user.id, owner.accountId!, nl.id, grant, install.clock.now())
      const actor: Actor = { userId: client.session.user.id, email: client.email, owner: false, grants: grant === 'outsider' ? {} : { [nl.id]: grant }, access: 'full', via: 'web', installAdmin: false }
      const campaign = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Draft' })
      const contact = await owner.action('contacts.create', { newsletterId: nl.id, email: `${grant}-contact@example.com` })
      const segment = await owner.action('segments.create', { newsletterId: nl.id, name: 'Segment', filter: { field: 'status', in: ['subscribed'] } })
      const author = await owner.action('authors.create', { newsletterId: nl.id, name: 'Writer', slug: `writer-${grant}` })
      const tag = await owner.action('tags.create', { newsletterId: nl.id, name: `Tag ${grant}` })
      const field = await owner.action('contactFields.create', { newsletterId: nl.id, key: `custom_${grant}`, label: 'Custom', type: 'text' })
      const code = '123456'
      control.db.run('INSERT INTO account_email_changes (user_id, email, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)', actor.userId, `${grant}-new@example.com`, await sha256Hex(`${actor.userId}:${code}`), install.clock.now() + 60_000)
      const token = `${grant}-invitation-token-for-matrix`
      control.db.run('INSERT INTO invites (id, account_id, newsletter_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', `inv_${grant}`, owner.accountId!, nl.id, client.email, 'member', await sha256Hex(token), owner.session.user.id, install.clock.now() + 86_400_000)
      const input: Record<string, unknown> = {
        accountId: owner.accountId, newsletterId: nl.id, campaignId: campaign.id, contactId: contact.contact.id,
        segmentId: segment.id, authorId: author.id, tagId: tag.id, fieldId: field.id, userId: client.session.user.id,
        inviteId: `inv_${grant}`, token, keyId: 'key_example', domainId: 'dom_example', suppressionId: 'sup_example',
        name: 'example.com', slug: `updated-${grant}`, role: 'member', email: `${grant}-new@example.com`,
        key: `new_${grant}`, label: 'New label', type: 'text', filter: { field: 'status', in: ['subscribed'] },
        revision: campaign.revision, theme: nl.theme, contactIds: [contact.contact.id], tagIds: [tag.id],
        operation: 'tag', data: 'iVBORw0KGgo=', contentType: 'image/png', kind: 'logo', width: 1, height: 1,
        currentPassword: 'correct horse battery', newPassword: 'a new correct password', code,
        confirmation: 'DELETE', sessionId: 'session_example', plan: 'starter', interval: 'monthly',
        access: 'full', values: {}, to: 'test@example.com', reason: 'Test reason', alertId: 'alert_example',
        value: 'closed',
      }
      if (action.name === 'newsletters.update') delete input.domainId
      if (action.name === 'admin.deadJobs') input.operation = 'list'
      if (action.name === 'admin.setSetting') { input.key = 'signup_mode'; input.value = 'closed' }
      Object.assign(input, fixture)
      assert.ok(action.input.safeParse(input).success, `${action.name}: update its valid input fixture: ${JSON.stringify(action.input.safeParse(input))}`)
      const allow = expected === 'user' || ((expected === 'member' || expected === 'teammate') && grant !== 'outsider') || (expected === 'admin' && grant === 'admin')
      const ctx = action.scope === 'account' ? install.app.account(owner.accountId!).ctx : control
      if (action.scope === 'account' && action.resource) {
        await assert.rejects(() => runAction(ctx, action.name, input, { ...actor, grants: { another_newsletter: 'admin' } }), (error: unknown) => error instanceof AppError && [403, 404].includes(error.status), `${action.name} must deny a grant for another newsletter`)
      }
      if (allow) {
        if (expectedError) {
          await assert.rejects(() => runAction(ctx, action.name, input, actor), (error: unknown) => error instanceof AppError && error.code === expectedError, `${action.name} must allow ${grant} through to its domain precondition`)
        } else {
          try { await runAction(ctx, action.name, input, actor) } catch (error) { assert.fail(`${action.name} must allow ${grant}: ${String(error)}`) }
        }
      } else {
        await assert.rejects(() => runAction(ctx, action.name, input, actor), (error: unknown) => error instanceof AppError && (error.status === 403 || error.status === 404), `${action.name} must deny ${grant}`)
      }
    }
  } finally { install.close() }
})
