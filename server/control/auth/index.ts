import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { hashPassword, randomCode, randomToken, sha256Hex, verifyPassword } from '../../core/crypto.ts'
import { newId } from '../../core/ids.ts'
import { AppError, clientIp, readJson, validate, type StoreEnv } from '../../core/http.ts'
import { allowRate, clearRate } from '../../core/ratelimit.ts'
import { sendSystemEmail, simpleEmail } from '../../email/platform-email.ts'
import { appUrl, learnAppUrl, getSettingSync } from '../install/index.ts'
import { createAccountForUser, isInstallAdmin, resolveSession } from '../accounts/index.ts'
import type { ControlRegistrar } from '../rpc.ts'

export const SESSION_COOKIE = 'mc_session'
export const ACCOUNT_COOKIE = 'mc_account'
const SESSION_DAYS = 30
const CODE_TTL_MS = 15 * 60_000
const CODE_MAX_ATTEMPTS = 5

interface UserRow {
  id: string
  email: string
  name: string
  password_hash: string
  email_verified_at: number | null
  is_install_admin: number
  disabled: number
  created_at: number
}

const email = z.string().trim().toLowerCase().email().max(254)
const password = z.string().min(8).max(200)
const name = z.string().trim().min(1).max(120)
const code = z.string().trim().regex(/^\d{6}$/)

export const sessionIdOf = (token: string) => sha256Hex(token)

const userByEmail = (ctx: StoreCtx, value: string) => ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', value)
const userCount = (ctx: StoreCtx) => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n

/** The origin the visitor used, honoring a reverse proxy's forwarded headers. */
export function requestOrigin(c: Context<any>): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || url.host
  return `${proto}://${host}`
}

const secureCookies = (ctx: StoreCtx) => appUrl(ctx).startsWith('https://')

export async function startSession(ctx: StoreCtx, c: Context<StoreEnv>, userId: string) {
  const token = randomToken()
  const now = ctx.now()
  ctx.db.run(
    'INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    await sessionIdOf(token),
    userId,
    randomToken(16),
    now,
    now + SESSION_DAYS * 86_400_000,
    clientIp(c),
    (c.req.header('user-agent') || '').slice(0, 300),
  )
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secureCookies(ctx), path: '/', maxAge: SESSION_DAYS * 86_400 })
}

async function endSession(ctx: StoreCtx, c: Context<StoreEnv>) {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) ctx.db.run('DELETE FROM sessions WHERE id = ?', await sessionIdOf(token))
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  deleteCookie(c, ACCOUNT_COOKIE, { path: '/' })
}

async function currentSession(ctx: StoreCtx, c: Context<StoreEnv>) {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const id = await sessionIdOf(token)
  const info = resolveSession(ctx, id, getCookie(c, ACCOUNT_COOKIE))
  return info ? { id, info } : null
}

function limit(ctx: StoreCtx, c: Context<StoreEnv>, address: string) {
  const ok = allowRate(ctx.db, `auth:ip:${clientIp(c) || 'none'}`, 30, 15 * 60_000, ctx.now()) && allowRate(ctx.db, `auth:email:${address}`, 10, 15 * 60_000, ctx.now())
  if (!ok) throw new AppError('rate_limited', 'Too many attempts. Try again in a few minutes.', 429)
}

async function issueCode(ctx: StoreCtx, address: string, purpose: 'signup' | 'signin' | 'reset') {
  const value = randomCode()
  ctx.db.run(
    'INSERT INTO login_codes (email, code_hash, purpose, expires_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(email, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0',
    address,
    await sha256Hex(`${purpose}:${value}`),
    purpose,
    ctx.now() + CODE_TTL_MS,
  )
  const copy = {
    signup: { subject: 'Your MailCorgi sign-up code', title: 'Confirm your email', lines: ['Enter this code to finish signing up. It expires in 15 minutes.'] },
    signin: { subject: 'Your MailCorgi sign-in code', title: 'Sign in to MailCorgi', lines: ['Enter this code to sign in. It expires in 15 minutes.'] },
    reset: { subject: 'Reset your MailCorgi password', title: 'Reset your password', lines: ['Enter this code to choose a new password. It expires in 15 minutes. If you did not ask for this, ignore this email.'] },
  }[purpose]
  await sendSystemEmail(ctx, { to: address, subject: copy.subject, kind: `auth.${purpose}`, ...simpleEmail({ title: copy.title, lines: copy.lines, code: value }) })
}

async function consumeCode(ctx: StoreCtx, address: string, purpose: 'signup' | 'signin' | 'reset', value: string) {
  const row = ctx.db.get<{ code_hash: string; expires_at: number; attempts: number }>('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ? AND purpose = ?', address, purpose)
  const bad = () => new AppError('bad_code', 'That code is wrong or has expired.', 400)
  if (!row || row.expires_at < ctx.now()) throw bad()
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw new AppError('bad_code', 'Too many wrong codes. Ask for a new one.', 400)
  if (row.code_hash !== (await sha256Hex(`${purpose}:${value}`))) {
    ctx.db.run('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?', address, purpose)
    throw bad()
  }
  ctx.db.run('DELETE FROM login_codes WHERE email = ? AND purpose = ?', address, purpose)
}

export const signupOpen = (ctx: StoreCtx) => getSettingSync(ctx, 'signup_mode') !== 'closed' && (ctx.config.cloud || allowedEmails(ctx).length > 0)
const allowedEmails = (ctx: StoreCtx) => [...ctx.config.allowedEmails, ...getSettingSync(ctx, 'allowed_emails').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]

/** Whether an address may sign itself up. Invitations are handled by the team unit. */
function mayJoin(ctx: StoreCtx, address: string) {
  const mode = getSettingSync(ctx, 'signup_mode')
  if (mode === 'closed') return false
  if (ctx.config.cloud && mode !== 'allowlist') return true
  return allowedEmails(ctx).includes(address) || ctx.config.adminEmails.includes(address)
}

async function createUser(ctx: StoreCtx, input: { email: string; name: string; password: string; verified: boolean; installAdmin?: boolean }): Promise<UserRow> {
  const id = newId('usr')
  const now = ctx.now()
  ctx.db.run(
    'INSERT INTO users (id, email, name, password_hash, email_verified_at, is_install_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    input.email,
    input.name,
    await hashPassword(input.password),
    input.verified ? now : null,
    input.installAdmin || ctx.config.adminEmails.includes(input.email) ? 1 : 0,
    now,
  )
  return userByEmail(ctx, input.email)!
}

export const authModule = {
  name: 'auth',
  register(reg: ControlRegistrar) {
    reg.maintenance((ctx) => {
      ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', ctx.now())
      ctx.db.run('DELETE FROM login_codes WHERE expires_at < ?', ctx.now())
    })

    reg.routes((app) => {
      app.get('/api/auth/bootstrap', async (c) => {
        const ctx = c.get('ctx')
        const session = await currentSession(ctx, c)
        return c.json({
          setupRequired: !ctx.config.cloud && userCount(ctx) === 0,
          cloud: ctx.config.cloud,
          signupOpen: signupOpen(ctx),
          appUrl: appUrl(ctx) || requestOrigin(c),
          session: session?.info ?? null,
        })
      })

      app.post('/api/auth/setup', async (c) => {
        const ctx = c.get('ctx')
        if (ctx.config.cloud) throw new AppError('not_found', 'Not found.', 404)
        const input = validate(z.object({ name, email, password }), await readJson(c))
        if (userCount(ctx) > 0) throw new AppError('setup_done', 'This install is already set up. Sign in instead.', 409)
        const user = await createUser(ctx, { ...input, verified: true, installAdmin: true })
        await createAccountForUser(ctx, user)
        learnAppUrl(ctx, requestOrigin(c))
        await startSession(ctx, c, user.id)
        return c.json({ ok: true })
      })

      app.post('/api/auth/signup', async (c) => {
        const ctx = c.get('ctx')
        const input = validate(z.object({ name, email, password }), await readJson(c))
        limit(ctx, c, input.email)
        if (!mayJoin(ctx, input.email)) throw new AppError('signup_closed', 'Sign-up is by invitation. Ask the person who runs this install.', 403)
        const existing = userByEmail(ctx, input.email)
        if (existing?.email_verified_at) throw new AppError('email_taken', 'An account with that email already exists. Sign in instead.', 409)
        if (!ctx.config.cloud) {
          const user = existing ?? (await createUser(ctx, { ...input, verified: true }))
          if (existing) ctx.db.run('UPDATE users SET email_verified_at = ?, name = ?, password_hash = ? WHERE id = ?', ctx.now(), input.name, await hashPassword(input.password), existing.id)
          await createAccountForUser(ctx, user)
          learnAppUrl(ctx, requestOrigin(c))
          await startSession(ctx, c, user.id)
          return c.json({ ok: true, pending: false })
        }
        if (existing) ctx.db.run('UPDATE users SET name = ?, password_hash = ? WHERE id = ?', input.name, await hashPassword(input.password), existing.id)
        else await createUser(ctx, { ...input, verified: false })
        await issueCode(ctx, input.email, 'signup')
        return c.json({ ok: true, pending: true })
      })

      app.post('/api/auth/signup/verify', async (c) => {
        const ctx = c.get('ctx')
        const input = validate(z.object({ email, code }), await readJson(c))
        limit(ctx, c, input.email)
        const user = userByEmail(ctx, input.email)
        if (!user) throw new AppError('bad_code', 'That code is wrong or has expired.', 400)
        await consumeCode(ctx, input.email, 'signup', input.code)
        if (!user.email_verified_at) ctx.db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', ctx.now(), user.id)
        await createAccountForUser(ctx, user)
        learnAppUrl(ctx, requestOrigin(c))
        await startSession(ctx, c, user.id)
        clearRate(ctx.db, `auth:email:${input.email}`)
        return c.json({ ok: true })
      })

      app.post('/api/auth/signin', async (c) => {
        const ctx = c.get('ctx')
        const input = validate(z.object({ email, password: z.string().min(1).max(200) }), await readJson(c))
        limit(ctx, c, input.email)
        const user = userByEmail(ctx, input.email)
        const wrong = () => new AppError('bad_credentials', 'Wrong email or password.', 401)
        if (!user || user.disabled || !user.password_hash || !(await verifyPassword(input.password, user.password_hash))) throw wrong()
        if (!user.email_verified_at) throw new AppError('unverified', 'Confirm your email first. Sign up again to get a new code.', 403)
        learnAppUrl(ctx, requestOrigin(c))
        await startSession(ctx, c, user.id)
        clearRate(ctx.db, `auth:email:${input.email}`)
        return c.json({ ok: true })
      })

      app.post('/api/auth/code', async (c) => {
        const ctx = c.get('ctx')
        if (!ctx.config.cloud) throw new AppError('not_found', 'Not found.', 404)
        const input = validate(z.object({ email }), await readJson(c))
        limit(ctx, c, input.email)
        const user = userByEmail(ctx, input.email)
        if (user && user.email_verified_at && !user.disabled) await issueCode(ctx, input.email, 'signin')
        return c.json({ ok: true })
      })

      app.post('/api/auth/signin/code', async (c) => {
        const ctx = c.get('ctx')
        const input = validate(z.object({ email, code }), await readJson(c))
        limit(ctx, c, input.email)
        const user = userByEmail(ctx, input.email)
        if (!user || user.disabled) throw new AppError('bad_code', 'That code is wrong or has expired.', 400)
        await consumeCode(ctx, input.email, 'signin', input.code)
        learnAppUrl(ctx, requestOrigin(c))
        await startSession(ctx, c, user.id)
        return c.json({ ok: true })
      })

      app.post('/api/auth/signout', async (c) => {
        await endSession(c.get('ctx'), c)
        return c.json({ ok: true })
      })

      app.post('/api/auth/reset', async (c) => {
        const ctx = c.get('ctx')
        const input = validate(z.object({ email }), await readJson(c))
        limit(ctx, c, input.email)
        const user = userByEmail(ctx, input.email)
        if (user && !user.disabled) await issueCode(ctx, input.email, 'reset')
        return c.json({ ok: true })
      })

      app.post('/api/auth/reset/confirm', async (c) => {
        const ctx = c.get('ctx')
        const input = validate(z.object({ email, code, password }), await readJson(c))
        limit(ctx, c, input.email)
        const user = userByEmail(ctx, input.email)
        if (!user) throw new AppError('bad_code', 'That code is wrong or has expired.', 400)
        await consumeCode(ctx, input.email, 'reset', input.code)
        ctx.db.run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', await hashPassword(input.password), ctx.now(), user.id)
        ctx.db.run('DELETE FROM sessions WHERE user_id = ?', user.id)
        await startSession(ctx, c, user.id)
        return c.json({ ok: true })
      })

      app.get('/api/auth/sessions', async (c) => {
        const ctx = c.get('ctx')
        const session = await currentSession(ctx, c)
        if (!session) throw new AppError('unauthorized', 'Sign in to continue.', 401)
        const rows = ctx.db.all<{ id: string; created_at: number; expires_at: number; ip: string; user_agent: string }>(
          'SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
          session.info.user.id,
          ctx.now(),
        )
        return c.json({ sessions: rows.map((r) => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent, current: r.id === session.id })) })
      })

      app.post('/api/auth/sessions/revoke', async (c) => {
        const ctx = c.get('ctx')
        const session = await currentSession(ctx, c)
        if (!session) throw new AppError('unauthorized', 'Sign in to continue.', 401)
        const input = validate(z.object({ id: z.string().min(1) }), await readJson(c))
        ctx.db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', input.id, session.info.user.id)
        if (input.id === session.id) await endSession(ctx, c)
        return c.json({ ok: true })
      })

      app.post('/api/auth/account', async (c) => {
        const ctx = c.get('ctx')
        const session = await currentSession(ctx, c)
        if (!session) throw new AppError('unauthorized', 'Sign in to continue.', 401)
        const input = validate(z.object({ accountId: z.string().min(1) }), await readJson(c))
        if (!session.info.accounts.some((a) => a.id === input.accountId)) throw new AppError('not_found', 'That account was not found.', 404)
        setCookie(c, ACCOUNT_COOKIE, input.accountId, { httpOnly: true, sameSite: 'Lax', secure: secureCookies(ctx), path: '/', maxAge: 365 * 86_400 })
        return c.json({ ok: true })
      })
    })
  },
}

export { isInstallAdmin }
