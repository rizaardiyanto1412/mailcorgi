import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createContext, runInContext } from 'node:vm'
import { z } from 'zod'

const code = await build({ entryPoints: [new URL('../../web/src/features/imports/csv.worker.ts', import.meta.url).pathname], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' })
const messageSchema = z.object({ kind: z.string(), seq: z.number().optional(), total: z.number().optional(), final: z.boolean().optional(), rows: z.array(z.record(z.string(), z.string())).optional(), message: z.string().optional() })
function worker(csv: string, mode: 'upload' | 'preview') {
  const messages: z.infer<typeof messageSchema>[] = []
  const reads: number[] = []
  const scope: { postMessage(value: unknown): void; onmessage?: unknown } = { postMessage: (v) => { messages.push(messageSchema.parse(v)) } }
  const context = createContext({ self: scope, csv, mode, TextEncoder, setTimeout,
    FileReaderSync: class { readAsText(text: string) { reads.push(text.length); return text } },
  })
  runInContext(code.outputFiles[0].text, context)
  runInContext('self.onmessage({ data: { kind: mode, file: { size: csv.length, slice(start, end) { return csv.slice(start, end) } } } })', context)
  return { messages, reads, resume: () => runInContext('self.onmessage({ data: { kind: "continue" } })', context) }
}

test('bundled CSV worker previews five rows and pauses every 500 records until acknowledged', () => {
  const csv = 'email,name\n' + Array.from({ length: 1001 }, (_, i) => `reader${i}@example.com,"Reader, ${i}"\n`).join('')
  const preview = worker(csv, 'preview')
  assert.equal(preview.messages.length, 1)
  assert.equal(preview.messages[0].kind, 'preview')
  assert.equal(preview.messages[0].rows?.length, 5)
  const upload = worker(csv, 'upload')
  assert.equal(upload.messages.length, 1)
  assert.equal(upload.messages[0].rows?.length, 500)
  upload.resume()
  assert.equal(upload.messages.length, 2)
  assert.equal(upload.messages[1].rows?.length, 500)
  upload.resume()
  assert.equal(upload.messages.length, 3)
  assert.equal(upload.messages[2].rows?.length, 1)
  assert.equal(upload.messages[2].final, true)
  assert.equal(upload.messages[2].total, 1001)
  assert.equal(new Set(upload.messages.flatMap((m) => m.rows ?? []).map((r) => r.email)).size, 1001)
  assert.equal(upload.messages[0].rows?.[0].name, 'Reader, 0')
})

test('bundled CSV worker rejects malformed rows and duplicate headers without uploading them', () => {
  for (const csv of ['email,email\na@example.com,b@example.com\n', 'email,name\na@example.com,One,Extra\n']) {
    const result = worker(csv, 'upload')
    assert.equal(result.messages[0].kind, 'error')
    assert.equal(result.messages.length, 1)
  }
})

test('100 MB CSV is read in bounded slices with backpressure', { skip: process.env.IMPORTS_SLOW !== '1', timeout: 120_000 }, () => {
  const row = 'reader@example.com,' + 'x'.repeat(1000) + '\n'
  const count = Math.floor((100 * 1024 * 1024 - 11) / row.length)
  const csv = 'email,name\n' + row.repeat(count)
  const preview = worker(csv, 'preview')
  assert.deepEqual(preview.reads, [256 * 1024])
  assert.equal(preview.messages[0].rows?.length, 5)
  const upload = worker(csv, 'upload')
  let total = 0
  while (true) {
    const chunk = upload.messages.pop()
    assert.ok(chunk)
    assert.equal(chunk.kind, 'chunk')
    assert.ok(chunk.rows && chunk.rows.length <= 500)
    total += chunk.rows.length
    if (chunk.final) break
    upload.resume()
  }
  assert.equal(total, count)
  assert.ok(upload.reads.every((size) => size <= 256 * 1024))
})

test('wide CSV rows produce smaller chunks that fit the HTTP upload limit', () => {
  const csv = 'email,name\n' + Array.from({ length: 100 }, (_, i) => `reader${i}@example.com,${'x'.repeat(15000)}\n`).join('')
  const result = worker(csv, 'upload')
  const chunks = []
  while (true) {
    const chunk = result.messages.pop()
    assert.ok(chunk)
    chunks.push(chunk)
    assert.ok(new TextEncoder().encode(JSON.stringify(chunk.rows)).length <= 800_000)
    if (chunk.final) break
    result.resume()
  }
  assert.equal(chunks.flatMap((c) => c.rows ?? []).length, 100)
  assert.equal(new Set(chunks.flatMap((c) => c.rows ?? []).map((r) => r.email)).size, 100)
})
