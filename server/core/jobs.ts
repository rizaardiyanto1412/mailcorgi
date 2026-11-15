import { MAX_PARAMS, type Db } from './db.ts'
import type { StoreCtx } from './store.ts'
import { newId } from './ids.ts'
import { randomToken } from './crypto.ts'

export const JOBS_SQL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  claim_token TEXT,
  last_error TEXT,
  dedupe_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(run_at);
CREATE TABLE jobs_dead (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  died_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`

export const MAX_ATTEMPTS = 8
export const LEASE_MS = 5 * 60_000

/** Outbound requests and time an invocation may still spend. One budget is shared by every handler in it. */
export class Budget {
  private requests: number
  constructor(
    public readonly deadline: number,
    requests: number,
    private readonly clock: () => number,
  ) {
    this.requests = requests
  }
  /** How many outbound requests the caller may make now, at most `n`. */
  take(n: number): number {
    const granted = Math.max(0, Math.min(n, this.requests))
    this.requests -= granted
    return granted
  }
  left(): number {
    return this.requests
  }
  expired(): boolean {
    return this.clock() >= this.deadline
  }
}

export type JobResult = 'done' | { again: number }
export interface JobRow {
  id: string
  kind: string
  payload: string
  run_at: number
  attempts: number
  locked_until: number | null
  claim_token: string | null
  last_error: string | null
  dedupe_key: string | null
  created_at: number
}
/** Handlers are async and idempotent: a job can run twice. */
export type JobHandler<P = any> = (ctx: StoreCtx, payload: P, budget: Budget, job: { id: string; kind: string; attempts: number }) => Promise<JobResult>

export interface Jobs {
  /** Inserts the row and arms the alarm. A duplicate `dedupeKey` keeps the existing job. */
  enqueue(kind: string, payload?: unknown, opts?: { runAt?: number; dedupeKey?: string }): { id: string; created: boolean }
  cancel(id: string): boolean
  cancelByKey(dedupeKey: string): boolean
}

export function createJobs(db: Db, now: () => number, onEnqueue: (runAt: number) => void): Jobs {
  return {
    enqueue(kind, payload = {}, opts = {}) {
      const runAt = opts.runAt ?? now()
      if (opts.dedupeKey) {
        const existing = db.get<{ id: string }>('SELECT id FROM jobs WHERE dedupe_key = ?', opts.dedupeKey)
        if (existing) return { id: existing.id, created: false }
      }
      const id = newId('job')
      db.run('INSERT INTO jobs (id, kind, payload, run_at, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)', id, kind, JSON.stringify(payload ?? {}), runAt, now(), opts.dedupeKey ?? null)
      onEnqueue(runAt)
      return { id, created: true }
    },
    cancel: (id) => db.run('DELETE FROM jobs WHERE id = ? AND claim_token IS NULL', id).changes > 0,
    cancelByKey: (key) => db.run('DELETE FROM jobs WHERE dedupe_key = ? AND claim_token IS NULL', key).changes > 0,
  }
}

/** When the alarm should fire next: the earliest due job, or the earliest lease expiry. */
export function nextWakeAt(db: Db): number | null {
  const row = db.get<{ at: number | null }>('SELECT MIN(COALESCE(locked_until, run_at)) AS at FROM jobs')
  return row?.at ?? null
}

export const backoffMs = (attempts: number) => Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1)) * (0.75 + Math.random() * 0.5)

export interface RunOptions {
  maxJobs?: number
  onDead?: (ctx: StoreCtx, job: JobRow, error: string) => void
}

/** Claim and run due jobs until nothing is due, the budget expires or `maxJobs` ran. */
export async function runDueJobs(ctx: StoreCtx, budget: Budget, opts: RunOptions = {}): Promise<number> {
  const { db } = ctx
  const max = Math.min(opts.maxJobs ?? 50, MAX_PARAMS - 2)
  const seen: string[] = []
  let ran = 0
  while (ran < max && !budget.expired()) {
    const job = claim(ctx, seen)
    if (!job) break
    seen.push(job.id)
    ran++
    const handler = ctx.registry.jobs.get(job.kind)
    if (!handler) {
      fail(ctx, job, `No handler for job kind ${job.kind}.`, opts)
      continue
    }
    try {
      const result = await handler(ctx, JSON.parse(job.payload), budget, { id: job.id, kind: job.kind, attempts: job.attempts })
      if (result === 'done') db.run('DELETE FROM jobs WHERE id = ? AND claim_token = ?', job.id, job.claim_token)
      else db.run('UPDATE jobs SET run_at = ?, locked_until = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?', Math.max(result.again, ctx.now()), job.id, job.claim_token)
    } catch (err) {
      fail(ctx, job, err instanceof Error ? err.message : String(err), opts)
    }
  }
  return ran
}

/** The next due job that this run has not touched yet, so a job that yields does not spin. */
function claim(ctx: StoreCtx, exclude: string[]): JobRow | null {
  const { db } = ctx
  const now = ctx.now()
  return db.tx(() => {
    const skip = exclude.length ? ` AND id NOT IN (${exclude.map(() => '?').join(', ')})` : ''
    const job = db.get<JobRow>(`SELECT * FROM jobs WHERE run_at <= ? AND (locked_until IS NULL OR locked_until <= ?)${skip} ORDER BY run_at LIMIT 1`, now, now, ...exclude)
    if (!job) return null
    const token = randomToken(16)
    const claimed = db.run('UPDATE jobs SET locked_until = ?, claim_token = ? WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)', now + LEASE_MS, token, job.id, now).changes
    return claimed ? { ...job, locked_until: now + LEASE_MS, claim_token: token } : null
  })
}

function fail(ctx: StoreCtx, job: JobRow, error: string, opts: RunOptions) {
  const { db } = ctx
  const attempts = job.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    db.tx(() => {
      const gone = db.run('DELETE FROM jobs WHERE id = ? AND claim_token = ?', job.id, job.claim_token).changes
      if (gone) db.run('INSERT OR REPLACE INTO jobs_dead (id, kind, payload, attempts, last_error, created_at, died_at) VALUES (?, ?, ?, ?, ?, ?, ?)', job.id, job.kind, job.payload, attempts, error, job.created_at, ctx.now())
      if (gone) opts.onDead?.(ctx, { ...job, attempts }, error)
    })
    return
  }
  db.run('UPDATE jobs SET attempts = ?, run_at = ?, locked_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ?', attempts, ctx.now() + backoffMs(attempts), error, job.id, job.claim_token)
}

/** Put a dead job back in the queue. Returns false when it is not there. */
export function retryDead(db: Db, id: string, now: number): boolean {
  return db.tx(() => {
    const dead = db.get<JobRow>('SELECT * FROM jobs_dead WHERE id = ?', id)
    if (!dead) return false
    db.run('DELETE FROM jobs_dead WHERE id = ?', id)
    db.run('INSERT INTO jobs (id, kind, payload, run_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)', dead.id, dead.kind, dead.payload, now, dead.created_at)
    return true
  })
}
