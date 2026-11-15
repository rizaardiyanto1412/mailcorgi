import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { apiDocPath, renderApiDoc } from '../../scripts/docs-api.ts'

test('docs/api.md matches the action registry', () => {
  assert.ok(fs.readFileSync(apiDocPath, 'utf8') === renderApiDoc(), 'docs/api.md is stale: run npm run docs:api')
})
