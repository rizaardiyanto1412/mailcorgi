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

/** Apply the migrations that are not yet in `_migrations`. Returns how many ran. */
export function migrate(db: Db, migrations: readonly string[], now: () => number = Date.now): number {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = db.get<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM _migrations')?.n ?? 0
  let ran = 0
  for (let i = applied; i < migrations.length; i++) {
    db.tx(() => {
      db.exec(migrations[i])
      db.run('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', i + 1, now())
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
