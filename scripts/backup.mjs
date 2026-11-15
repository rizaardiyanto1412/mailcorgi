#!/usr/bin/env node
/**
 * Back up or restore a Node install's DATA_DIR. Plain JavaScript so it runs in the Docker image.
 *
 *   node scripts/backup.mjs                    write DATA_DIR/backups/mailcorgi-<time>/ and print its path
 *   node scripts/backup.mjs restore <folder>   replace the data in DATA_DIR with that backup (stop the app first)
 *
 * Databases are copied with SQLite's online backup API, so the app may keep running during a backup.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

const dataDir = path.resolve(process.env.DATA_DIR || './data')

function databases(dir, rel = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = path.join(rel, entry.name)
    if (entry.isDirectory() && name === 'accounts') out.push(...databases(dir, name))
    else if (entry.isFile() && entry.name.endsWith('.db')) out.push(name)
  }
  return out
}

async function runBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dataDir, 'backups', `mailcorgi-${stamp}`)
  fs.mkdirSync(path.join(target, 'accounts'), { recursive: true })
  const files = databases(dataDir)
  for (const file of files) {
    const source = new DatabaseSync(path.join(dataDir, file), { readOnly: true })
    try {
      await backup(source, path.join(target, file))
    } finally {
      source.close()
    }
  }
  for (const extra of ['secret.key', 'images']) {
    const from = path.join(dataDir, extra)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(target, extra), { recursive: true })
  }
  console.log(`${files.length} databases backed up to ${target}`)
  console.log(target)
}

function runRestore(from) {
  if (!from) throw new Error('Name the backup folder: node scripts/backup.mjs restore <folder>')
  const source = path.resolve(from)
  if (!fs.existsSync(path.join(source, 'control.db'))) throw new Error(`${source} has no control.db. Is it a MailCorgi backup?`)
  for (const entry of fs.readdirSync(dataDir)) {
    if (entry === 'backups') continue
    // Old -wal and -shm files must go too, or SQLite would replay them over the restored database.
    fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true })
  }
  for (const entry of fs.readdirSync(source)) fs.cpSync(path.join(source, entry), path.join(dataDir, entry), { recursive: true })
  console.log(`Restored ${source} into ${dataDir}. Start MailCorgi again.`)
}

try {
  if (process.argv[2] === 'restore') runRestore(process.argv[3])
  else await runBackup()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
