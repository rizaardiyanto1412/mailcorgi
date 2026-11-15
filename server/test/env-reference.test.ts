import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ENV_VARS, INTERNAL_ENV, applyEnvReference, docPath, readEnvNames } from '../../scripts/env-reference.ts'
import { parseConfig } from '../core/config.ts'
import { SETTING_KEYS } from '../control/install/index.ts'

test('every environment variable the code reads is documented, and every documented one is read', () => {
  const read = readEnvNames()
  const documented = new Set(ENV_VARS.map((v) => v.name))
  assert.equal(documented.size, ENV_VARS.length, 'a variable is listed twice')
  const undocumented = [...read].filter((name) => !documented.has(name) && !INTERNAL_ENV.has(name)).sort()
  assert.deepEqual(undocumented, [], 'add these to ENV_VARS in scripts/env-reference.ts')
  const stale = [...documented, ...INTERNAL_ENV.keys()].filter((name) => !read.has(name)).sort()
  assert.deepEqual(stale, [], 'remove these from scripts/env-reference.ts: no code reads them')
})

test('the scanner sees what parseConfig and install settings really read', () => {
  const touched = new Set<string>()
  const env = new Proxy({} as Record<string, string | undefined>, { get: (_t, key) => { if (typeof key === 'string') touched.add(key); return undefined } })
  parseConfig(env)
  const read = readEnvNames()
  for (const name of touched) assert.ok(read.has(name), `${name} is read by parseConfig but the scanner missed it`)
  for (const key of SETTING_KEYS) assert.ok(read.has(key.toUpperCase()), `${key} can be set from the environment but the scanner missed it`)
})

test('docs/self-hosting.md carries the current generated reference', () => {
  const doc = fs.readFileSync(docPath, 'utf8')
  assert.equal(applyEnvReference(doc), doc, 'run: npx tsx scripts/env-reference.ts')
})
