import { z } from 'zod'
import { defineAction, type Actor } from '../../core/actions.ts'
import { randomToken, sha256Hex } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'
import { newId } from '../../core/ids.ts'
import type { StoreCtx } from '../../core/store.ts'
import { sendSystemEmail, simpleEmail } from '../../email/platform-email.ts'
import { planLimits } from '../billing/index.ts'
import { appUrl } from '../install/index.ts'
import { ownedAccount } from './index.ts'

const accountId = z.string().min(1).describe('The account that owns the newsletter.')
const newsletterId = z.string().min(1).describe('The newsletter to share.')
const inviteId = z.string().min(1).describe('The pending invitation id.')
const userId = z.string().min(1).describe('The team member user id.')
const role = z.enum(['admin', 'member']).describe('Admins send, import and manage settings; members write drafts and read stats.')
const token = z.string().min(20).max(200).describe('The secret token from the emailed invitation link.')
const scope = { accountId, newsletterId }
const WEEK = 7 * 86_400_000
interface Invite {
  id: string
  account_id: string
  newsletter_id: string
  email: string
  role: 'admin' | 'member'
  token_hash: string
  invited_by: string
  expires_at: number
  accepted_at: number | null
}

function activeInvite(ctx: StoreCtx, hash: string): Invite {
  const row = ctx.db.get<Invite>('SELECT i.* FROM invites i JOIN accounts a ON a.id = i.account_id WHERE i.token_hash = ? AND a.deleted_at IS NULL AND a.status != ?', hash, 'deleting')
  if (!row || row.accepted_at !== null || row.expires_at <= ctx.now()) throw new AppError('invalid_invite', 'This invitation has expired or was already used or revoked. Ask the owner for a new one.', 410)
  return row
}

export async function validateInviteSignup(ctx: StoreCtx, value: string, email: string) {
  const invite = activeInvite(ctx, await sha256Hex(value))
  if (invite.email !== email) throw new AppError('wrong_account', 'Use the email address this invitation was sent to.', 403)
}

async function newsletter(ctx: StoreCtx, input: { accountId: string; newsletterId: string }) {
  const list = await ctx.stores.account(input.accountId).teamNewsletters({ newsletterIds: [input.newsletterId] })
  const row = list.find((n) => n.id === input.newsletterId)
  if (!row) throw new AppError('not_found', 'Newsletter not found.', 404)
  return row
}

async function ownerNewsletter(ctx: StoreCtx, input: { accountId: string; newsletterId: string }, actor: Actor) {
  ownedAccount(ctx, input.accountId, actor.userId)
  return newsletter(ctx, input)
}

function checkCapacity(ctx: StoreCtx, input: { accountId: string; newsletterId: string }, omitInvite = '') {
  const account = ctx.db.get<{ plan: string }>('SELECT plan FROM accounts WHERE id = ? AND deleted_at IS NULL', input.accountId)
  if (!account) throw new AppError('not_found', 'Account not found.', 404)
  const limit = planLimits(account.plan, ctx.config.cloud).maxTeamPerNewsletter ?? (ctx.config.cloud ? 5 : Infinity)
  const members = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE account_id = ? AND newsletter_id = ?', input.accountId, input.newsletterId)!.n
  const pending = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invites WHERE account_id = ? AND newsletter_id = ? AND accepted_at IS NULL AND expires_at > ? AND id != ?', input.accountId, input.newsletterId, ctx.now(), omitInvite)!.n
  if (members + pending >= limit) throw new AppError('limit_reached', 'This newsletter has reached its team limit. Remove a member or revoke a pending invitation.', 403)
}

function limitInvites(ctx: StoreCtx, email: string, ownerId: string) {
  if (!allowRate(ctx.db, `team:email:${email}`, 5, 86_400_000, ctx.now()) || !allowRate(ctx.db, `team:owner:${ownerId}`, 50, 3_600_000, ctx.now())) throw new AppError('rate_limited', 'Too many invitations. Try again later.', 429)
}

async function emailInvite(ctx: StoreCtx, invite: Invite, secret: string, name: string) {
  const failed = () => new AppError('email_failed', 'The invitation was saved but email delivery failed. Check email settings, then use resend to try again.', 502)
  try {
    const result = await sendSystemEmail(ctx, {
      to: invite.email, subject: `Join ${name} on MailCorgi`, kind: 'team.invite',
      ...simpleEmail({ title: `You’re invited to ${name}`, lines: [`Join as ${invite.role === 'admin' ? 'an admin' : 'a member'}. This link expires in 7 days.`, 'Sign in or create an account with this email address to accept.'], link: { label: 'Accept invitation', url: `${appUrl(ctx)}/invite?token=${encodeURIComponent(secret)}` } }),
    })
    if (!result.ok) throw failed()
  } catch {
    throw failed()
  }
}

const inviteSummary = (i: Invite) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at })

export const teamActions = [
  defineAction({ name: 'team.list', description: 'List this newsletter’s members and pending invitations. Only the owner manages the team.', scope: 'control', role: 'user', effect: 'read', resource: { type: 'account', param: 'accountId' }, input: z.object(scope), handler: async (ctx, input, actor) => {
    await ownerNewsletter(ctx, input, actor)
    return {
      members: ctx.db.all<{ userId: string; name: string; email: string; role: 'admin' | 'member' }>('SELECT u.id AS userId, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? AND m.newsletter_id = ? ORDER BY m.created_at, u.id', input.accountId, input.newsletterId),
      invites: ctx.db.all<Invite>('SELECT * FROM invites WHERE account_id = ? AND newsletter_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY expires_at, id', input.accountId, input.newsletterId, ctx.now()).map(inviteSummary),
    }
  } }),
  defineAction({ name: 'team.invite', description: 'Invite someone to a newsletter. Pending invitations reserve team seats.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ ...scope, email: z.string().trim().toLowerCase().email().max(254).describe('The address that must accept this invitation.'), role }), handler: async (ctx, input, actor) => {
    const nl = await ownerNewsletter(ctx, input, actor)
    const secret = randomToken()
    const hash = await sha256Hex(secret)
    const invite = ctx.db.tx(() => {
      ownedAccount(ctx, input.accountId, actor.userId)
      const user = ctx.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', input.email)
      if (user && ctx.db.get('SELECT user_id FROM memberships WHERE user_id = ? AND account_id = ? AND (newsletter_id = ? OR role = ?)', user.id, input.accountId, input.newsletterId, 'owner')) throw new AppError('already_member', 'That person already has access.', 409)
      if (ctx.db.get('SELECT id FROM invites WHERE account_id = ? AND newsletter_id = ? AND email = ? AND accepted_at IS NULL AND expires_at > ?', input.accountId, input.newsletterId, input.email, ctx.now())) throw new AppError('already_invited', 'That person already has a pending invitation. Use resend instead.', 409)
      checkCapacity(ctx, input)
      limitInvites(ctx, input.email, actor.userId)
      const row: Invite = { id: newId('inv'), account_id: input.accountId, newsletter_id: input.newsletterId, email: input.email, role: input.role, token_hash: hash, invited_by: actor.userId, expires_at: ctx.now() + WEEK, accepted_at: null }
      ctx.db.run('INSERT INTO invites (id, account_id, newsletter_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.account_id, row.newsletter_id, row.email, row.role, row.token_hash, row.invited_by, row.expires_at)
      return row
    })
    await emailInvite(ctx, invite, secret, nl.name)
    return inviteSummary(invite)
  } }),
  defineAction({ name: 'team.resend', description: 'Replace an unused invitation link and email it again.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ ...scope, inviteId }), handler: async (ctx, input, actor) => {
    const nl = await ownerNewsletter(ctx, input, actor)
    const secret = randomToken()
    const hash = await sha256Hex(secret)
    const invite = ctx.db.tx(() => {
      ownedAccount(ctx, input.accountId, actor.userId)
      const row = ctx.db.get<Invite>('SELECT * FROM invites WHERE id = ? AND account_id = ? AND newsletter_id = ? AND accepted_at IS NULL', input.inviteId, input.accountId, input.newsletterId)
      if (!row) throw new AppError('not_found', 'Pending invitation not found.', 404)
      if (row.expires_at - WEEK > ctx.now() - 60_000) throw new AppError('rate_limited', 'Wait a minute before resending this invitation.', 429)
      checkCapacity(ctx, input, row.id)
      limitInvites(ctx, row.email, actor.userId)
      row.token_hash = hash
      row.expires_at = ctx.now() + WEEK
      ctx.db.run('UPDATE invites SET token_hash = ?, expires_at = ? WHERE id = ?', hash, row.expires_at, row.id)
      return row
    })
    await emailInvite(ctx, invite, secret, nl.name)
    return inviteSummary(invite)
  } }),
  defineAction({ name: 'team.revoke', description: 'Revoke a pending newsletter invitation.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ ...scope, inviteId }), handler: (ctx, input, actor) => {
    ownedAccount(ctx, input.accountId, actor.userId)
    ctx.db.run('DELETE FROM invites WHERE id = ? AND account_id = ? AND newsletter_id = ? AND accepted_at IS NULL', input.inviteId, input.accountId, input.newsletterId)
    return { ok: true }
  } }),
  defineAction({ name: 'team.changeRole', description: 'Change a newsletter team member’s role.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ ...scope, userId, role }), handler: (ctx, input, actor) => {
    ownedAccount(ctx, input.accountId, actor.userId)
    if (!ctx.db.run('UPDATE memberships SET role = ? WHERE user_id = ? AND account_id = ? AND newsletter_id = ? AND role != ?', input.role, input.userId, input.accountId, input.newsletterId, 'owner').changes) throw new AppError('not_found', 'Team member not found.', 404)
    return { ok: true }
  } }),
  defineAction({ name: 'team.remove', description: 'Remove a member’s access to this newsletter.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ ...scope, userId }), handler: (ctx, input, actor) => {
    ownedAccount(ctx, input.accountId, actor.userId)
    ctx.db.run('DELETE FROM memberships WHERE user_id = ? AND account_id = ? AND newsletter_id = ? AND role != ?', input.userId, input.accountId, input.newsletterId, 'owner')
    return { ok: true }
  } }),
  defineAction({ name: 'team.leave', description: 'Leave a newsletter shared with you. Owners cannot leave their own account.', scope: 'control', role: 'user', effect: 'write', input: z.object(scope), handler: (ctx, input, actor) => {
    if (ctx.db.get('SELECT id FROM accounts WHERE id = ? AND owner_user_id = ?', input.accountId, actor.userId)) throw new AppError('forbidden', 'The owner cannot leave their own newsletter.', 403)
    if (!ctx.db.run('DELETE FROM memberships WHERE user_id = ? AND account_id = ? AND newsletter_id = ? AND role != ?', actor.userId, input.accountId, input.newsletterId, 'owner').changes) throw new AppError('not_found', 'Shared newsletter not found.', 404)
    return { ok: true }
  } }),
  defineAction({ name: 'team.accept', description: 'Accept a single-use invitation with the email address it was sent to.', scope: 'control', role: 'user', effect: 'write', input: z.object({ token }), handler: async (ctx, input, actor) => {
    const hash = await sha256Hex(input.token)
    const invite = activeInvite(ctx, hash)
    const scope = { accountId: invite.account_id, newsletterId: invite.newsletter_id }
    if (invite.email !== actor.email) throw new AppError('wrong_account', 'This invitation is for a different email address. Sign out and sign in with the address that received it.', 403)
    await newsletter(ctx, scope)
    ctx.db.tx(() => {
      const current = activeInvite(ctx, hash)
      const existing = ctx.db.get('SELECT user_id FROM memberships WHERE user_id = ? AND account_id = ? AND (newsletter_id = ? OR role = ?)', actor.userId, current.account_id, current.newsletter_id, 'owner')
      if (!existing) {
        checkCapacity(ctx, scope, current.id)
        ctx.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, ?, ?, ?)', actor.userId, current.account_id, current.newsletter_id, current.role, ctx.now())
      }
      ctx.db.run('UPDATE invites SET accepted_at = ? WHERE id = ?', ctx.now(), current.id)
    })
    return scope
  } }),
  defineAction({ name: 'team.newsletters', description: 'List your own and shared newsletters grouped by account.', scope: 'control', role: 'user', effect: 'read', input: z.object({}), handler: async (ctx, _input, actor) => {
    const rows = ctx.db.all<{ id: string; name: string; newsletter_id: string | null; role: string }>('SELECT a.id, a.name, m.newsletter_id, m.role FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.user_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at, a.id', actor.userId)
    const groups = new Map<string, { id: string; name: string; owner: boolean; ids: string[] }>()
    for (const row of rows) {
      const group = groups.get(row.id) ?? { id: row.id, name: row.name, owner: false, ids: [] }
      if (row.role === 'owner' && row.newsletter_id === null) group.owner = true
      else if (row.newsletter_id) group.ids.push(row.newsletter_id)
      groups.set(row.id, group)
    }
    return { accounts: await Promise.all([...groups.values()].map(async (a) => ({ id: a.id, name: a.name, owner: a.owner, newsletters: await ctx.stores.account(a.id).teamNewsletters({ newsletterIds: a.owner ? null : a.ids }) }))) }
  } }),
] as const
