import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decrypt, deriveKeys, encrypt, hashPassword, openEnvelope, signEnvelope, verifyPassword } from '../core/crypto.ts'
import { formatApiKey, newId, newNewsletterKey, parseApiKey, parseNewsletterKey, accountIdOfToken } from '../core/ids.ts'

test('passwords hash with PBKDF2 and verify', async () => {
  const hash = await hashPassword('correct horse battery')
  assert.match(hash, /^pbkdf2:100000:/)
  assert.ok(await verifyPassword('correct horse battery', hash))
  assert.ok(!(await verifyPassword('wrong', hash)))
  assert.ok(!(await verifyPassword('x', 'garbage')))
})

test('credentials round-trip through AES-GCM and fail closed', async () => {
  const keys = await deriveKeys('a'.repeat(32))
  const stored = await encrypt(keys.credentials, 'secret value')
  assert.match(stored, /^v1:/)
  assert.equal(await decrypt(keys.credentials, stored), 'secret value')
  const other = await deriveKeys('b'.repeat(32))
  assert.equal(await decrypt(other.credentials, stored), '')
  assert.equal(await decrypt(keys.credentials, stored.slice(0, -2) + 'AA'), '')
})

test('envelopes open only with the signing key and reject tampering', async () => {
  const keys = await deriveKeys('c'.repeat(32))
  const sealed = await signEnvelope(keys.session, { actor: { userId: 'u' }, aud: 'control', exp: 1 })
  assert.deepEqual(await openEnvelope(keys.session, sealed), { actor: { userId: 'u' }, aud: 'control', exp: 1 })
  assert.equal(await openEnvelope(keys.session, sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null)
  assert.equal(await openEnvelope((await deriveKeys('d'.repeat(32))).session, sealed), null)
})

test('derived keys differ per purpose and per account', async () => {
  const keys = await deriveKeys('e'.repeat(32))
  assert.notDeepEqual(keys.session, keys.credentials)
  assert.notDeepEqual(await keys.tokenKey('acc_aaaaaaaaaaaaaaaa'), await keys.tokenKey('acc_bbbbbbbbbbbbbbbb'))
})

test('ids and key formats parse', () => {
  const id = newId('acc')
  assert.match(id, /^acc_[a-z2-7]{16}$/)
  assert.deepEqual(parseApiKey(formatApiKey(id, 'x'.repeat(32))), { accountId: id, secret: 'x'.repeat(32) })
  assert.equal(parseApiKey('mc_bad'), null)
  assert.deepEqual(parseNewsletterKey(newNewsletterKey(id)), { accountId: id })
  assert.equal(accountIdOfToken(`${id}.u.abc.def`), id)
  assert.equal(accountIdOfToken('nope'), null)
})
