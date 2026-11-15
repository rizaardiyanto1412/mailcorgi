import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expectError } from './harness.ts'
import { createIssue, drive, parseHeaders, sendableInstall, tokensIn } from './sending-setup.ts'

for (const cloud of [false, true]) test(`a confirmed public subscriber receives issues once until one-click unsubscribe (${cloud ? 'cloud' : 'self-hosted'})`, async (t) => {
  const { install, owner, nl, accountId } = await sendableInstall({ cloud })
  t.after(() => install.close())
  await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome reader', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Welcome aboard.' }] }] }, revision: null })
  const response = await install.fetch(`/api/public/subscribe/${nl.key}`)
  assert.equal(response.status, 200)
  const config: { formToken: string } = await response.json()
  install.clock.advance(2001)
  const signup = await install.fetch(`/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.com', formToken: config.formToken }) })
  assert.equal(signup.status, 200)
  const confirm = install.outbox(accountId).find((mail) => mail.subject.startsWith('Confirm'))
  assert.ok(confirm)
  const link = /http:\/\/app\.example\.com\/confirm\/[^\s<>"\]]+/.exec(confirm.text)?.[0]
  assert.ok(link)
  assert.equal((await install.fetch(link)).status, 200)
  const welcome = install.outbox(accountId).find((mail) => mail.subject === 'Welcome reader')
  assert.ok(welcome)
  for (const mail of [confirm, welcome]) {
    const preferenceToken = tokensIn(mail.html, '/u/').find((token) => token.includes('.p.'))
    assert.ok(preferenceToken, mail.html)
    const preferences = await install.fetch(`/u/${preferenceToken}`)
    assert.equal(preferences.status, 200)
    assert.match(await preferences.text(), /reader@example.com/)
    const unsubscribePage = parseHeaders(mail.headers)['List-Unsubscribe'].match(/<(http[^>]+)>/)?.[1]
    assert.ok(unsubscribePage)
    assert.equal((await install.fetch(unsubscribePage)).status, 200)
  }
  const first = await createIssue(owner, nl.id, { audience: { all: true } })
  assert.equal((await owner.action('campaigns.send', { campaignId: first.id })).planned, 1)
  assert.equal((await drive(install, owner, first.id)).status, 'sent')
  await install.runJobs()
  const sent = install.outbox(accountId).filter((mail) => mail.kind === 'campaign')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to_email, 'reader@example.com')
  const unsubscribe = parseHeaders(sent[0].headers)['List-Unsubscribe'].match(/<(http[^>]+)>/)?.[1]
  assert.ok(unsubscribe)
  assert.equal((await install.fetch(unsubscribe, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status, 200)
  assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0].status, 'unsubscribed')
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'other-reader@example.com' })
  const next = await createIssue(owner, nl.id, { audience: { all: true } })
  assert.equal((await owner.action('campaigns.audienceCount', { campaignId: next.id })).total, 1)
  assert.equal((await owner.action('campaigns.send', { campaignId: next.id })).planned, 1)
  assert.equal((await drive(install, owner, next.id)).status, 'sent')
  await install.runJobs()
  const campaigns = install.outbox(accountId).filter((mail) => mail.kind === 'campaign')
  assert.deepEqual(campaigns.map((mail) => mail.to_email), ['reader@example.com', 'other-reader@example.com'])
})

test('welcome and keep drafts are excluded from issue lists and cannot be sent or scheduled', async (t) => {
  const { install, owner, nl, ctx } = await sendableInstall()
  t.after(() => install.close())
  const issue = await createIssue(owner, nl.id)
  for (const kind of ['welcome', 'keep']) {
    const draft = await createIssue(owner, nl.id)
    ctx.db.run('UPDATE campaigns SET kind = ? WHERE id = ? AND newsletter_id = ?', kind, draft.id, nl.id)
    assert.equal((await expectError(() => owner.action('campaigns.send', { campaignId: draft.id }))).code, 'not_issue')
    assert.equal((await expectError(() => owner.action('campaigns.schedule', { campaignId: draft.id, scheduledAt: install.clock.now() + 60_000 }))).code, 'not_issue')
  }
  const listed = await owner.action('campaigns.list', { newsletterId: nl.id })
  assert.deepEqual(listed.campaigns.map((campaign) => campaign.id), [issue.id])
  assert.equal(listed.total, 1)
})
