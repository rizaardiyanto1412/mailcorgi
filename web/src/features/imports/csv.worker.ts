/// <reference lib="webworker" />
import Papa from 'papaparse'
import type { CsvRow } from '../../../../server/account/imports/model.ts'

declare const self: DedicatedWorkerGlobalScope
let parser: Papa.Parser | null = null
let rows: CsvRow[] = []
let seq = 0
let total = 0
let bytes = 2
let mode: 'preview' | 'upload' = 'preview'
self.onmessage = (event: MessageEvent<{ kind: 'preview' | 'upload'; file: File } | { kind: 'continue' }>) => {
  const message = event.data
  if (message.kind === 'continue') { parser?.resume(); return }
  mode = message.kind
  rows = []; seq = 0; total = 0; bytes = 2
  Papa.parse<CsvRow>(message.file, {
    header: true, skipEmptyLines: 'greedy', chunkSize: 256 * 1024,
    transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
    step(result, handle) {
      parser = handle
      if (result.errors.length || result.meta.renamedHeaders) {
        self.postMessage({ kind: 'error', message: result.errors[0]?.message ?? 'The CSV has duplicate column headers. Rename them first.' })
        handle.abort(); return
      }
      if (Object.keys(result.data).some((key) => key.length > 200) || Object.values(result.data).some((v) => typeof v !== 'string' || v.length > 20_000)) {
        self.postMessage({ kind: 'error', message: 'A CSV column or cell is too long.' }); handle.abort(); return
      }
      const rowBytes = new TextEncoder().encode(JSON.stringify(result.data)).length + 1
      if (rowBytes > 800_000) {
        self.postMessage({ kind: 'error', message: 'A CSV row is too large. Remove unused columns first.' }); handle.abort(); return
      }
      total++
      if (mode === 'upload' && rows.length && bytes + rowBytes > 800_000) {
        handle.pause()
        self.postMessage({ kind: 'chunk', seq: seq++, rows, total: total - 1 })
        rows = [result.data]; bytes = 2 + rowBytes
        return
      }
      rows.push(result.data); bytes += rowBytes
      if (mode === 'preview' && rows.length === 5) {
        self.postMessage({ kind: 'preview', headers: result.meta.fields ?? [], rows }); handle.abort(); return
      }
      if (mode === 'upload' && rows.length === 500) {
        handle.pause()
        self.postMessage({ kind: 'chunk', seq: seq++, rows, total })
        rows = []; bytes = 2
      }
    },
    complete(result) {
      if (result.meta.aborted) return
      if (mode === 'preview') self.postMessage({ kind: 'preview', headers: result.meta.fields ?? Object.keys(rows[0] ?? {}), rows })
      else {
        if (rows.length) self.postMessage({ kind: 'chunk', seq: seq++, rows, total, final: true })
        else self.postMessage({ kind: 'complete', total })
      }
    },
    error(error) { self.postMessage({ kind: 'error', message: error.message }) },
  })
}
