import type { Install, Client } from './harness.ts'
import type { CsvRow } from '../account/imports/model.ts'
import type { ActionInput } from '../registry.ts'

export async function finish(install: Install, owner: Client, newsletterId: string, importId: string) {
  for (let i = 0; i < 300; i++) {
    await install.runJobs()
    const report = await owner.action('imports.get', { newsletterId, importId })
    if (report.status === 'completed') return report
    install.clock.advance(1000)
  }
  throw new Error('Import did not finish')
}
export async function upload(owner: Client, newsletterId: string, rows: CsvRow[], extra: Partial<ActionInput<'imports.create'>> = {}) {
  const imp = await owner.action('imports.create', { newsletterId, mapping: { email: 'email', status: 'status', signupDate: 'created_at' }, options: { consent: true }, ...extra })
  for (let seq = 0; seq * 500 < rows.length; seq++) await owner.action('imports.addChunk', { newsletterId, importId: imp.id, seq, rows: rows.slice(seq * 500, (seq + 1) * 500) })
  await owner.action('imports.start', { newsletterId, importId: imp.id, totalRows: rows.length })
  return imp.id
}
