import type { PermissionEntries } from '../permission-types.ts'

export const entries = {
  'imports.create': { role: 'admin', input: { mapping: { email: 'email' } } },
  'imports.addChunk': { role: 'admin', input: { importId: 'imp_example', seq: 0, rows: [{ email: 'reader@example.com' }] }, error: 'not_found' },
  'imports.start': { role: 'admin', input: { importId: 'imp_example', totalRows: 0 }, error: 'not_found' },
  'imports.cancel': { role: 'admin', input: { importId: 'imp_example' }, error: 'not_found' },
  'imports.get': { role: 'member', input: { importId: 'imp_example' }, error: 'not_found' },
  'imports.list': { role: 'member' },
  'imports.skipped': { role: 'member', input: { importId: 'imp_example' }, error: 'not_found' },
} satisfies PermissionEntries
