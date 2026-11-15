/**
 * SQLite access. The engine is the same everywhere; the driver differs per platform:
 * node:sqlite on a server (platform-node.ts), Durable Object storage on Cloudflare (worker/).
 */
export type SqlValue = string | number | bigint | null | Uint8Array
export type Param = string | number | bigint | null | undefined | boolean | Uint8Array

export interface Driver {
  all(sql: string, params: SqlValue[]): any[]
  run(sql: string, params: SqlValue[]): { id: number; changes: number }
  exec(sql: string): void
  transaction<T>(fn: () => T): T
}

/**
 * Rows a store has written and read since it was opened, as Cloudflare bills them: index entries
 * count on Durable Objects, and every `setAlarm` is one row written. Node counts `changes`.
 */
export interface Meter {
  writes: number
  reads: number
  /** The same counts per statement (whitespace-collapsed SQL, or `setAlarm`), for `npm run budget`. */
  statements: Record<string, { writes: number; reads: number }>
}
export const createMeter = (): Meter => ({ writes: 0, reads: 0, statements: {} })
/** Add one statement's rows to the meter. A statement is keyed by its text, so a loop shows as one line with a big count. */
export function meterStatement(meter: Meter, sql: string, writes: number, reads: number) {
  meter.writes += writes
  meter.reads += reads
  const key = sql.replace(/\s+/g, ' ').trim().slice(0, 200)
  const entry = meter.statements[key] ?? (meter.statements[key] = { writes: 0, reads: 0 })
  entry.writes += writes
  entry.reads += reads
}

/** The message Cloudflare returns once the day's row writes are used up, and the other ways a write can be refused. */
export const isWriteRefused = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /rows written|write limit|writes? (?:limit|quota)|SQLITE_FULL|database or disk is full|readonly database|storage limit/i.test(message)
}

export interface Db {
  all<T = any>(sql: string, ...params: Param[]): T[]
  get<T = any>(sql: string, ...params: Param[]): T | undefined
  run(sql: string, ...params: Param[]): { id: number; changes: number }
  exec(sql: string): void
  /** Synchronous and re-entrant: an inner tx joins the outer one. */
  tx<T>(fn: () => T): T
}

/** Durable Object SQL binds at most 100 parameters per statement. */
export const MAX_PARAMS = 100

const norm = (params: Param[]) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as SqlValue[]

export function createDb(driver: Driver): Db {
  let depth = 0
  return {
    all: (sql, ...params) => driver.all(sql, norm(params)),
    get: (sql, ...params) => driver.all(sql, norm(params))[0],
    run: (sql, ...params) => driver.run(sql, norm(params)),
    exec: (sql) => driver.exec(sql),
    tx(fn) {
      if (depth > 0) return fn()
      depth++
      try {
        return driver.transaction(fn)
      } finally {
        depth--
      }
    },
  }
}

/** Rewrite ":name" placeholders to positional ones, which every driver supports. */
export function named(sql: string, params: Record<string, Param>): { sql: string; params: Param[] } {
  const values: Param[] = []
  const positional = sql.replace(/(?<![:\w]):([a-zA-Z_]\w*)/g, (match, name: string) => {
    if (!(name in params)) return match
    values.push(params[name])
    return '?'
  })
  return { sql: positional, params: values }
}

export interface Migration {
  id: string
  sql: string
}

export function validateMigrations(migrations: readonly Migration[]): void {
  const ids = new Set<string>()
  for (const { id } of migrations) {
    if (!/^\d{4}-base$/.test(id) && !/^\d{4}-\d{2}-\d{2}-[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(id)) throw new Error(`Malformed migration id: ${id}`)
    if (!/^\d{4}-base$/.test(id)) {
      const date = id.slice(0, 10)
      const timestamp = Date.parse(`${date}T00:00:00Z`)
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new Error(`Malformed migration id: ${id}`)
    }
    if (ids.has(id)) throw new Error(`Duplicate migration id: ${id}`)
    ids.add(id)
  }
}

/** Base ids retain their old positions; module ids are independent of registration order. */
export function migrate(db: Db, migrations: readonly Migration[], now: () => number = Date.now): number {
  validateMigrations(migrations)
  const base = migrations.filter((m) => /^\d{4}-base$/.test(m.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const modules = migrations.filter((m) => !/^\d{4}-base$/.test(m.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  db.tx(() => {
    const columns = db.all<{ name: string; type: string }>('PRAGMA table_info(_migrations)')
    if (columns.some((c) => c.name === 'id' && c.type.toUpperCase() === 'INTEGER')) {
      const recorded = db.all<{ id: number; applied_at: number }>('SELECT id, applied_at FROM _migrations')
      for (const row of recorded) {
        if (!Number.isInteger(row.id) || row.id < 1 || row.id > base.length) throw new Error(`Unknown legacy migration position: ${row.id}`)
      }
      db.exec('ALTER TABLE _migrations RENAME TO _migrations_positional')
      db.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)')
      for (const row of recorded) db.run('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', base[row.id - 1].id, row.applied_at)
      db.exec('DROP TABLE _migrations_positional')
    } else {
      db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)')
    }
  })
  const applied = new Set(db.all<{ id: string }>('SELECT id FROM _migrations').map((row) => row.id))
  let ran = 0
  for (const migration of [...base, ...modules]) {
    if (applied.has(migration.id)) continue
    db.tx(() => {
      db.exec(migration.sql)
      db.run('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', migration.id, now())
    })
    ran++
  }
  return ran
}

/** Insert many rows in chunks that stay under the parameter limit. */
export function insertMany(db: Db, table: string, columns: string[], rows: Param[][], conflict = ''): number {
  if (rows.length === 0) return 0
  const perRow = columns.length
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / perRow))
  let changes = 0
  for (let at = 0; at < rows.length; at += perChunk) {
    const chunk = rows.slice(at, at + perChunk)
    const tuple = `(${columns.map(() => '?').join(', ')})`
    const sql = `INSERT ${conflict ? 'OR ' + conflict : ''} INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`
    changes += db.run(sql, ...chunk.flat()).changes
  }
  return changes
}

export const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
