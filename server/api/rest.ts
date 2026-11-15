import { z } from 'zod'
import type { Actor, AnyAction } from '../core/actions.ts'
import { exposedActions, runExposedAction } from './catalog.ts'
import type { StoreCtx } from '../core/store.ts'
import { AppError } from '../core/http.ts'
import { sha256Hex } from '../core/crypto.ts'
import { queryUsesJson } from './query.ts'
import { inputSchema } from './reference.ts'

export function matchAction(ctx: StoreCtx, method: string, path: string) {
  const segments = path.split('/')
  const candidates = exposedActions(ctx.registry).filter((a) => a.rest?.method === method).sort((a, b) => (a.rest!.path.match(/:/g)?.length ?? 0) - (b.rest!.path.match(/:/g)?.length ?? 0))
  for (const action of candidates) {
    const parts = action.rest!.path.split('/')
    if (parts.length !== segments.length) continue
    const params: Record<string, string> = {}
    let matches = true
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        try { params[parts[i].slice(1)] = decodeURIComponent(segments[i]) } catch { throw new AppError('invalid_input', 'Invalid path encoding.', 400) }
      } else if (parts[i] !== segments[i]) matches = false
    }
    if (matches) return { action, params }
  }
  throw new AppError('not_found', 'That endpoint was not found.', 404)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export async function restInput(request: Request, action: AnyAction, params: Record<string, string>) {
  let input: Record<string, unknown>
  if (request.method === 'GET') {
    const properties = inputSchema(action).properties ?? {}
    input = {}
    for (const [name, value] of new URL(request.url).searchParams) {
      const schema = properties[name]
      if (queryUsesJson(schema)) {
        try { input[name] = JSON.parse(value) } catch { throw new AppError('invalid_input', `${name}: Expected a JSON value.`, 400) }
      } else input[name] = value
    }
  } else {
    const text = await request.text()
    try { input = z.record(z.string(), z.unknown()).parse(text ? JSON.parse(text) : {}) } catch { throw new AppError('invalid_json', 'The request body must be a JSON object.', 400) }
  }
  return { ...input, ...params }
}

export async function executeRest(ctx: StoreCtx, action: AnyAction, input: unknown, actor: Actor, idempotencyKey: string | null): Promise<Response> {
  if (!idempotencyKey || action.effect === 'read') return Response.json(await runExposedAction(ctx, action, input, actor) ?? null)
  if (idempotencyKey.length > 200) throw new AppError('invalid_input', 'Idempotency-Key must be at most 200 characters.', 400)
  if (actor.access === 'read') throw new AppError('forbidden', 'This API key is read-only.', 403)
  const fingerprint = await sha256Hex(canonical({ action: action.name, input }))
  const key = `${actor.keyId}:${idempotencyKey}`
  const cached = ctx.db.tx(() => {
    ctx.db.run('DELETE FROM api_idempotency WHERE expires_at <= ?', ctx.now())
    const row = ctx.db.get<{ fingerprint: string; response: string | null; status: number | null }>('SELECT fingerprint, response, status FROM api_idempotency WHERE key = ?', key)
    if (row) {
      if (row.fingerprint !== fingerprint) throw new AppError('idempotency_conflict', 'This Idempotency-Key was used with another input.', 409)
      if (row.response === null) throw new AppError('idempotency_pending', 'This request is in progress or its outcome is uncertain. Inspect the resource before retrying.', 409)
      return row
    }
    ctx.db.run('INSERT INTO api_idempotency (key, fingerprint, expires_at) VALUES (?, ?, ?)', key, fingerprint, ctx.now() + 86_400_000)
    return null
  })
  if (cached) return new Response(cached.response, { status: cached.status ?? 200, headers: { 'Content-Type': 'application/json', 'Idempotency-Replayed': 'true' } })
  try {
    const result = JSON.stringify(await runExposedAction(ctx, action, input, actor) ?? null)
    ctx.db.run('UPDATE api_idempotency SET response = ?, status = 200 WHERE key = ?', result, key)
    return new Response(result, { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    // A handler may have committed before throwing. Retain the reservation to prevent a duplicate send.
    if (err instanceof AppError && err.status < 500) {
      const result = JSON.stringify({ error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } })
      ctx.db.run('UPDATE api_idempotency SET response = ?, status = ? WHERE key = ?', result, err.status, key)
    }
    throw err
  }
}
