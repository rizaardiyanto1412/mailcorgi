import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Install } from './harness.ts'
import { transitionCampaign } from '../account/campaigns/index.ts'
import { DELETE_STEPS } from '../account/newsletters/delete.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'

async function settle(install: Install, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    await install.runJobs()
    install.clock.advance(2_000)
  }
}

/** Rows that still belong to the newsletter, per table. */
function leftovers(install: Install, accountId: string, newsletterId: string) {
  const db = install.app.account(accountId).ctx.db
  const out: Record<string, number> = {}
  for (const step of DELETE_STEPS) {
    const n = db.all(step.select, newsletterId, 1_000_000).length
    if (n) out[step.table] = (out[step.table] ?? 0) + n
  }
  const uploads = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM uploads WHERE newsletter_id = ?', newsletterId)!.n
  if (uploads) out.uploads = uploads
  if (db.get('SELECT id FROM newsletters WHERE id = ?', newsletterId)) out.newsletters = 1
  return out
}

test('deleting a newsletter removes everything it owns in chunks, survives a storage failure, and leaves the others alone', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'member@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const doomed = await owner.action('newsletters.create', { name: 'Doomed weekly', slug: 'doomed-weekly' })
    const kept = await owner.action('newsletters.create', { name: 'Kept weekly', slug: 'kept-weekly' })
    const accountId = owner.accountId!
    const ctx = install.app.account(accountId).ctx
    const control = install.app.control.ctx

    for (const nl of [doomed, kept]) {
      const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'Fans' })
      await owner.action('contactFields.create', { newsletterId: nl.id, key: 'company', label: 'Company', type: 'text' })
      await owner.action('segments.create', { newsletterId: nl.id, name: 'Everyone', filter: { field: 'status', in: ['subscribed'] } })
      const contact = await owner.action('contacts.create', { newsletterId: nl.id, email: `reader-${nl.slug}@example.com`, tags: [tag.id] })
      await owner.action('contacts.delete', { newsletterId: nl.id, contactId: contact.contact.id })
      await owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: PNG, width: 1, height: 1 })
      await owner.action('newsletters.uploadImage', { newsletterId: nl.id, kind: 'logo', contentType: 'image/png', data: PNG })
      const author = await owner.action('authors.create', { newsletterId: nl.id, name: 'Writer', slug: 'writer' })
      await owner.action('authors.uploadAvatar', { newsletterId: nl.id, authorId: author.id, contentType: 'image/png', data: PNG })
      // Volume: more rows than one chunk, written the way imports and sends would.
      ctx.db.tx(() => {
        for (let i = 0; i < 1_200; i++) {
          ctx.db.run("INSERT INTO contacts (id, newsletter_id, email, status, source, fields, created_at, updated_at) VALUES (?, ?, ?, 'subscribed', 'import', '{}', ?, ?)", `ct_${nl.slug}_${i}`, nl.id, `bulk${i}-${nl.slug}@example.com`, 1, 1)
          ctx.db.run('INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)', `ct_${nl.slug}_${i}`, tag.id)
          ctx.db.run("INSERT INTO events (type, newsletter_id, contact_id, data, at) VALUES ('signup', ?, ?, '{}', ?)", nl.id, `ct_${nl.slug}_${i}`, i)
        }
      })
      const sent = await owner.action('campaigns.create', { newsletterId: nl.id, subject: `Sent ${nl.slug}` })
      transitionCampaign(ctx, sent.id, 'scheduled', { scheduledAt: ctx.now() + 1000 })
      transitionCampaign(ctx, sent.id, 'sending')
      transitionCampaign(ctx, sent.id, 'sent')
      ctx.db.tx(() => {
        for (let i = 0; i < 700; i++) ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at) VALUES (?, ?, ?, 'delivered', 1)", sent.id, `ct_${nl.slug}_${i}`, `bulk${i}-${nl.slug}@example.com`)
        ctx.db.run("INSERT INTO provider_events (id, delivery_id, type, occurred_at, received_at) VALUES (?, (SELECT MIN(id) FROM deliveries WHERE campaign_id = ?), 'delivered', 1, 1)", `pe_${nl.slug}`, sent.id)
      })
      await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Draft' })
      await owner.action('team.invite', { accountId, newsletterId: nl.id, email: `invitee-${nl.slug}@example.com`, role: 'member' })
    }
    const member = await install.signUp({ email: 'member@example.com' })
    control.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, ?, ?, ?)', member.session.user.id, accountId, doomed.id, 'admin', install.clock.now())
    await settle(install, 3)
    assert.ok(control.db.get('SELECT 1 FROM sites WHERE newsletter_id = ?', doomed.id), 'the directory knows the site')
    const keptBefore = leftovers(install, accountId, kept.id)
    const doomedBlobs = (await install.app.platform.blobs.list(`${accountId}/`)).length

    // Refusals: a wrong name, a scheduled campaign, and anyone but the owner.
    assert.equal((await expectError(() => owner.action('newsletters.delete', { newsletterId: doomed.id, confirmName: 'Doomed' }))).code, 'confirm_mismatch')
    const scheduled = await owner.action('campaigns.create', { newsletterId: doomed.id, subject: 'Later' })
    transitionCampaign(ctx, scheduled.id, 'scheduled', { scheduledAt: ctx.now() + 86_400_000 })
    assert.equal((await expectError(() => owner.action('newsletters.delete', { newsletterId: doomed.id, confirmName: 'Doomed weekly' }))).code, 'campaign_active')
    transitionCampaign(ctx, scheduled.id, 'canceled')
    await member.post('/api/auth/account', { accountId })
    assert.equal((await member.actionRaw('newsletters.delete', { newsletterId: doomed.id, confirmName: 'Doomed weekly' })).status, 403)

    // Storage fails once mid-way: the job retries and loses no image.
    const blobs = install.app.platform.blobs
    const realDelete = blobs.delete.bind(blobs)
    let failures = 1
    blobs.delete = async (key: string) => {
      if (failures-- > 0) throw new Error('storage is down')
      return realDelete(key)
    }

    assert.deepEqual(await owner.action('newsletters.delete', { newsletterId: doomed.id, confirmName: ' Doomed weekly ' }), { deleting: true })
    assert.deepEqual(await owner.action('newsletters.delete', { newsletterId: doomed.id, confirmName: 'Doomed weekly' }), { deleting: true }, 'a repeat call is safe')
    assert.deepEqual((await owner.action('newsletters.list', {})).newsletters.map((n) => n.id), [kept.id])
    assert.equal((await owner.actionRaw('contacts.list', { newsletterId: doomed.id })).status, 404)
    assert.equal((await owner.actionRaw('campaigns.get', { campaignId: scheduled.id })).status, 404, 'its rows are gone for actions at once')

    await settle(install)
    blobs.delete = realDelete
    assert.ok(failures < 0, 'the storage failure happened')
    assert.deepEqual(leftovers(install, accountId, doomed.id), {})
    assert.deepEqual(leftovers(install, accountId, kept.id), keptBefore, 'the other newsletter keeps everything')
    assert.equal((await blobs.list(`${accountId}/`)).length, doomedBlobs - 3, 'its image, logo and avatar are gone; the other newsletter keeps its three')
    assert.equal(control.db.get('SELECT 1 FROM memberships WHERE newsletter_id = ?', doomed.id), undefined)
    assert.equal(control.db.get('SELECT 1 FROM invites WHERE newsletter_id = ?', doomed.id), undefined)
    assert.equal(control.db.get('SELECT 1 FROM sites WHERE newsletter_id = ?', doomed.id), undefined)
    assert.ok(control.db.get('SELECT 1 FROM invites WHERE newsletter_id = ?', kept.id))
    assert.ok(control.db.get('SELECT 1 FROM sites WHERE newsletter_id = ?', kept.id))
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs_dead")!.n, 0)
    assert.equal(Number(ctx.db.get<{ value: string }>("SELECT value FROM account_meta WHERE key = 'active_contacts'")?.value ?? 0), ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE status IN ('subscribed', 'unconfirmed')")!.n)
    assert.equal((await owner.actionRaw('newsletters.delete', { newsletterId: doomed.id, confirmName: 'Doomed weekly' })).status, 404)
    assert.equal((await install.fetch('/n/doomed-weekly')).status, 404)
  } finally {
    install.close()
  }
})

test('every table that names a newsletter, campaign, contact or import is covered by the deletion', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const db = install.app.account(owner.accountId!).ctx.db
    const covered = new Set([...DELETE_STEPS.map((s) => s.table), 'uploads', 'newsletters', 'jobs', 'jobs_dead'])
    const missing: string[] = []
    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info("${name}")`).map((c) => c.name)
      if (cols.some((c) => ['newsletter_id', 'campaign_id', 'contact_id', 'import_id', 'delivery_id', 'tag_id'].includes(c)) && !covered.has(name)) missing.push(name)
    }
    assert.deepEqual(missing, [], 'add new tables to DELETE_STEPS in server/account/newsletters/delete.ts')
  } finally {
    install.close()
  }
})
