import fs from 'node:fs'
import path from 'node:path'
import { accountRegistry } from '../server/account/modules.ts'
import { markdown } from '../server/api/index.ts'

const output = path.resolve(import.meta.dirname, '../docs/api.md')
fs.writeFileSync(output, markdown(accountRegistry, 'https://mail.example.com'))
console.log(`Generated ${output}`)
