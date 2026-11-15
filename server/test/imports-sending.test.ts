import { test } from 'node:test'
import assert from 'node:assert/strict'
import Papa from 'papaparse'
import type { CsvRow } from '../account/imports/model.ts'
import { finish, upload } from './imports-setup.ts'
import { createIssue, drive, sendableInstall } from './sending-setup.ts'

for (const cloud of [false, true]) test(`imported subscribers receive an all-audience campaign once; imported opt-outs receive none (${cloud ? 'cloud' : 'self-hosted'})`, async (t) => {
  const { install, owner, nl, accountId } = await sendableInstall({ cloud })
  t.after(() => install.close())
  install.dns.set('example.com', 'MX', ['mx.example.com'])
  const csv = Papa.parse<CsvRow>('email,status\nreader-one@example.com,subscribed\nreader-two@example.com,active\noptout-one@example.com,unsubscribed\noptout-two@example.com,inactive\n', { header: true, skipEmptyLines: true })
  assert.deepEqual(csv.errors, [])
  const importId = await upload(owner, nl.id, csv.data)
  const report = await finish(install, owner, nl.id, importId)
  assert.equal(report.added, 2)
  assert.equal(report.skipped.imported_unsubscribed, 2)
  const contacts = (await owner.action('contacts.list', { newsletterId: nl.id })).contacts
  assert.deepEqual(contacts.filter((c) => c.status === 'unsubscribed').map((c) => c.email).sort(), ['optout-one@example.com', 'optout-two@example.com'])
  const issue = await createIssue(owner, nl.id, { audience: { all: true } })
  assert.equal((await owner.action('campaigns.send', { campaignId: issue.id })).planned, 2)
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  await install.runJobs()
  assert.deepEqual(install.outbox(accountId).filter((mail) => mail.kind === 'campaign').map((mail) => mail.to_email).sort(), ['reader-one@example.com', 'reader-two@example.com'])
})
