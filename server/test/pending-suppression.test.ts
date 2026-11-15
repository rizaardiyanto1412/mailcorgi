/**
 * When the platform refuses writes (the daily row quota), an unsubscribe or a complaint must not be
 * lost: it is parked in a place that still takes writes and applied before any later send.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signToken } from '../account/tracking/index.ts'
import { addContacts, createIssue, drive, sendableInstall } from './sending-setup.ts'
import type { Client, Install } from './harness.ts'

async function sentIssue(opts: Parameters<typeof sendableInstall>[0] = {}) {
  const setup = await sendableInstall(opts)
  const { install, owner, nl, ctx } = setup
  const contacts = addContacts(ctx, nl.id, 2)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  await install.runJobs()
  return { ...setup, issue, contacts }
}

const oneClick = (install: Install, token: string) => install.fetch(`/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
const campaignMailsTo = (install: Install, accountId: string, email: string) => install.outbox(accountId).filter((m) => m.kind === 'campaign' && m.to_email === email).length
const status = (install: Install, accountId: string, contactId: string) => install.app.account(accountId).ctx.db.get<{ status: string }>('SELECT status FROM contacts WHERE id = ?', contactId)!.status

/** Send a fresh issue to everyone still subscribed and return the campaign. */
async function sendAnother(install: Install, owner: Client, newsletterId: string) {
  const issue = await createIssue(owner, newsletterId, { subject: 'Issue two' })
  await owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  return issue
}

test('a one-click unsubscribe during a write refusal is kept across a restart and applied before any later send', async (t) => {
  const first = await sentIssue()
  const { owner, nl, accountId, issue, contacts } = first
  const token = await signToken(first.ctx, 'u', [contacts[0], issue.id])
  first.install.refuseWrites(true)
  const page = await oneClick(first.install, token)
  assert.equal(page.status, 200, 'the mail provider is told the request landed')
  assert.equal(status(first.install, accountId, contacts[0]), 'subscribed', 'nothing could be written yet')
  // The object is evicted while the quota is still exhausted; the next day writes work again.
  const install = await first.install.restart()
  t.after(() => install.close())
  const client = await install.clientFromCookie(owner.cookie)
  await sendAnother(install, client, nl.id)
  assert.equal(campaignMailsTo(install, accountId, 'reader0@example.com'), 1, 'the reader who unsubscribed received nothing more')
  assert.equal(campaignMailsTo(install, accountId, 'reader1@example.com'), 2)
  assert.equal(status(install, accountId, contacts[0]), 'unsubscribed')
  const report = await client.action('stats.report', { campaignId: issue.id })
  assert.equal(report.counts.unsubscribes, 1, 'the unsubscribe is credited to the issue it came from')
})

test('without a separate blob store the reader is told to try again, and a parked unsubscribe still lands once writes resume', async (t) => {
  const { install, nl, accountId, issue, contacts, ctx, owner } = await sentIssue()
  t.after(() => install.close())
  const token = await signToken(ctx, 'u', [contacts[0], issue.id])
  const blobs = ctx.platform.blobs as { separate?: boolean }
  const was = blobs.separate
  blobs.separate = false
  install.refuseWrites(true)
  try {
    const page = await oneClick(install, token)
    assert.equal(page.status, 503)
    assert.match(await page.text(), /try again later/i)
  } finally {
    blobs.separate = was
  }
  install.refuseWrites(false)
  await sendAnother(install, owner, nl.id)
  assert.equal(status(install, accountId, contacts[0]), 'unsubscribed', 'the instance survived, so its memory copy was applied')
  assert.equal(campaignMailsTo(install, accountId, 'reader0@example.com'), 1)
})

test('a complaint that arrives during a write refusal is kept and suppresses the address before any later send', async (t) => {
  const first = await sentIssue()
  const { owner, nl, accountId, issue, contacts } = first
  const delivery = first.ctx.db.get<{ id: number }>('SELECT id FROM deliveries WHERE campaign_id = ? AND contact_id = ?', issue.id, contacts[1])!
  first.install.refuseWrites(true)
  const result = await first.install.app.stores.account(accountId).ingestProviderEvents({ events: [{ id: 'evt-complaint-1', type: 'complaint', deliveryId: String(delivery.id), messageId: '', recipient: 'reader1@example.com', occurredAt: first.install.clock.now(), accountId }] })
  assert.equal(result.applied, 1, 'the webhook is answered so the provider stops retrying')
  const install = await first.install.restart()
  t.after(() => install.close())
  const client = await install.clientFromCookie(owner.cookie)
  await sendAnother(install, client, nl.id)
  assert.equal(campaignMailsTo(install, accountId, 'reader1@example.com'), 1, 'the complainer received nothing more')
  assert.equal(status(install, accountId, contacts[1]), 'complained')
  assert.ok(install.app.account(accountId).ctx.db.get('SELECT 1 FROM suppressions WHERE email = ?', 'reader1@example.com'), 'the address is suppressed')
})
