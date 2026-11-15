import fs from 'node:fs'
import path from 'node:path'
import { accountRegistry } from '../server/account/modules.ts'
import { markdown } from '../server/api/index.ts'

export const apiDocPath = path.resolve(import.meta.dirname, '../docs/api.md')
export const renderApiDoc = () => markdown(accountRegistry, 'https://mail.example.com')

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.writeFileSync(apiDocPath, renderApiDoc())
  console.log(`Generated ${apiDocPath}`)
}
