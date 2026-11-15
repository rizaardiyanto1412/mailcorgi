import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { defineAction, type Actor } from '../../core/actions.ts'
import { AppError, notFound } from '../../core/http.ts'
import { authorActions } from './authors.ts'
import { fromBase64 } from '../../core/crypto.ts'
import { newId, newNewsletterKey } from '../../core/ids.ts'
import { limits } from '../usage/index.ts'
import type { AccountRegistrar } from '../rpc.ts'

export interface NewsletterRow {
  id: string
  key: string
  name: string
  slug: string
  description: string
  language: string
  timezone: string
  from_name: string
  from_local: string
  domain_id: string | null
  reply_to: string
  postal_address: string
  logo_key: string | null
  icon_key: string | null
  theme: string
  website: string
  double_opt_in: number
  welcome: string
  hygiene: string
  tracking: string
  archived_at: number | null
  created_at: number
  updated_at: number
}

export interface Newsletter {
  id: string
  key: string
  name: string
  slug: string
  description: string
  language: string
  timezone: string
  fromName: string
  fromLocal: string
  domainId: string | null
  replyTo: string
  postalAddress: string
  logoKey: string | null
  iconKey: string | null
  tracking: { opens: boolean; clicks: boolean }
  doubleOptIn: boolean
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export const serializeNewsletter = (r: NewsletterRow): Newsletter => ({
  id: r.id,
  key: r.key,
  name: r.name,
  slug: r.slug,
  description: r.description,
  language: r.language,
  timezone: r.timezone,
  fromName: r.from_name,
  fromLocal: r.from_local,
  domainId: r.domain_id,
  replyTo: r.reply_to,
  postalAddress: r.postal_address,
  logoKey: r.logo_key,
  iconKey: r.icon_key,
  tracking: z.object({ opens: z.boolean().default(true), clicks: z.boolean().default(true) }).parse(JSON.parse(r.tracking)),
  doubleOptIn: !!r.double_opt_in,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export const getNewsletterRow = (ctx: StoreCtx, id: string) => ctx.db.get<NewsletterRow>('SELECT * FROM newsletters WHERE id = ?', id)

export function getNewsletter(ctx: StoreCtx, id: string): Newsletter {
  const row = getNewsletterRow(ctx, id)
  if (!row) throw notFound('That newsletter')
  return serializeNewsletter(row)
}

/** Newsletters the actor may see: all of them for the owner, granted ones for a team member. */
export function visibleNewsletters(ctx: StoreCtx, actor: Actor, includeArchived = false): Newsletter[] {
  const rows = ctx.db.all<NewsletterRow>(`SELECT * FROM newsletters ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at`)
  return rows.filter((r) => actor.owner || r.id in actor.grants).map(serializeNewsletter)
}

export const slugify = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/, 'Use 3 to 60 letters, digits and dashes.')
const RESERVED_SLUGS = new Set(['api', 'admin', 'app', 'www', 'mail', 'n', 'f', 't', 'u', 'img', 'hooks', 'mcp', 'docs', 'static', 'assets', 'healthz', 'signin', 'signup', 'setup', 'welcome'])

async function assertSlugFree(ctx: StoreCtx, value: string, newsletterId: string | null) {
  if (RESERVED_SLUGS.has(value)) throw new AppError('slug_taken', 'That address is reserved.', 409)
  const local = ctx.db.get<{ id: string }>('SELECT id FROM newsletters WHERE slug = ?', value)
  if (local && local.id !== newsletterId) throw new AppError('slug_taken', 'That address is already in use.', 409)
  const site = await ctx.stores.control.lookupSite({ slug: value })
  if (site && site.newsletter_id !== newsletterId) throw new AppError('slug_taken', 'That address is already in use.', 409)
}

const syncDirectory = (ctx: StoreCtx, newsletterId: string) => ctx.jobs.enqueue('directory.sync', { newsletterId }, { dedupeKey: `directory.sync:${newsletterId}` })

const newsletterId = z.string().min(1).describe('The newsletter id')

export const newslettersModule = {
  name: 'newsletters',
  register(reg: AccountRegistrar) {
    reg.resolver('newsletter', (ctx, id) => (getNewsletterRow(ctx, id) ? id : null))
    reg.resolver('author', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM authors WHERE id = ?', id)?.newsletter_id ?? null)

    reg.job<{ newsletterId: string }>('directory.sync', async (ctx, { newsletterId }) => {
      const row = getNewsletterRow(ctx, newsletterId)
      const accountId = ctx.accountId!
      if (!row || row.archived_at) await ctx.stores.control.removeSite({ newsletterId, accountId })
      else await ctx.stores.control.upsertSite({ newsletterId, accountId, slug: row.slug })
      return 'done'
    })

    return reg.actions(
      ...authorActions,
      defineAction({
        name: 'newsletters.uploadImage', description: 'Upload a newsletter logo or icon as PNG, JPEG, GIF or WebP, up to 2 MB.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' },
        input: z.object({ newsletterId, kind: z.enum(['logo', 'icon']).describe('Which newsletter image to replace'), contentType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).describe('The image MIME type'), data: z.string().min(1).max(2796204).describe('Base64-encoded image bytes') }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/images' }, mcp: { title: 'Upload a newsletter image', destructive: false },
        handler: async (ctx, i, actor) => {
          let bytes: Uint8Array
          try { bytes = fromBase64(i.data) } catch { throw new AppError('invalid_input', 'The image data is invalid.', 400) }
          const hex = Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
          const valid = i.contentType === 'image/png' ? hex.startsWith('89504e470d0a1a0a') : i.contentType === 'image/jpeg' ? hex.startsWith('ffd8ff') : i.contentType === 'image/gif' ? hex.startsWith('474946383761') || hex.startsWith('474946383961') : hex.startsWith('52494646') && hex.slice(16) === '57454250'
          if (!valid || bytes.length > 2097152) throw new AppError('invalid_input', 'Use a PNG, JPEG, GIF or WebP image under 2 MB.', 400)
          const key = newId('img')
          const fullKey = `${ctx.accountId}/${key}`
          await ctx.platform.blobs.put(fullKey, bytes, i.contentType)
          try {
            ctx.db.tx(() => {
              ctx.db.run('INSERT INTO uploads (key, newsletter_id, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', fullKey, i.newsletterId, i.contentType, bytes.length, actor.userId, ctx.now())
              ctx.db.run(`UPDATE newsletters SET ${i.kind === 'logo' ? 'logo_key' : 'icon_key'} = ?, updated_at = ? WHERE id = ?`, key, ctx.now(), i.newsletterId)
            })
          } catch (err) { await ctx.platform.blobs.delete(fullKey); throw err }
          return getNewsletter(ctx, i.newsletterId)
        },
      }),
      defineAction({
        name: 'newsletters.create',
        description: 'Create a newsletter. The slug becomes its public address under /n/.',
        scope: 'account',
        role: 'owner',
        effect: 'write',
        input: z.object({
          name: z.string().trim().min(1).max(120).describe('The newsletter name'),
          slug: slug.optional().describe('Public address slug. Made from the name when left out.'),
        }),
        rest: { method: 'POST', path: '/newsletters' },
        mcp: { title: 'Create a newsletter', destructive: false },
        handler: async (ctx, input) => {
          const active = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM newsletters WHERE archived_at IS NULL')!.n
          if (active >= limits(ctx).maxNewsletters) throw new AppError('limit_reached', 'This account has reached its newsletter limit.', 403)
          const wanted = input.slug ?? slugify(input.name)
          if (wanted.length < 3) throw new AppError('invalid_input', 'slug: Use 3 to 60 letters, digits and dashes.', 400)
          await assertSlugFree(ctx, wanted, null)
          const id = newId('nl')
          const now = ctx.now()
          ctx.db.tx(() => {
            ctx.db.run('INSERT INTO newsletters (id, key, name, slug, from_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, newNewsletterKey(ctx.accountId!), input.name, wanted, input.name, now, now)
            syncDirectory(ctx, id)
          })
          return getNewsletter(ctx, id)
        },
      }),
      defineAction({
        name: 'newsletters.list',
        description: 'List the newsletters you can see.',
        scope: 'account',
        role: 'member',
        effect: 'read',
        input: z.object({ includeArchived: z.boolean().optional().describe('Also return archived newsletters') }),
        rest: { method: 'GET', path: '/newsletters' },
        mcp: { title: 'List newsletters', destructive: false },
        handler: (ctx, input, actor) => ({ newsletters: visibleNewsletters(ctx, actor, input.includeArchived) }),
      }),
      defineAction({
        name: 'newsletters.get',
        description: 'Read one newsletter.',
        scope: 'account',
        role: 'member',
        effect: 'read',
        resource: { type: 'newsletter', param: 'newsletterId' },
        input: z.object({ newsletterId }),
        rest: { method: 'GET', path: '/newsletters/:newsletterId' },
        mcp: { title: 'Get a newsletter', destructive: false },
        handler: (ctx, { newsletterId }) => getNewsletter(ctx, newsletterId),
      }),
      defineAction({
        name: 'newsletters.update',
        description: 'Update newsletter identity, sender, postal address, language and subscription settings.',
        scope: 'account',
        role: 'admin',
        effect: 'write',
        resource: { type: 'newsletter', param: 'newsletterId' },
        input: z.object({
          newsletterId,
          name: z.string().trim().min(1).max(120).optional().describe('New name'),
          description: z.string().trim().max(500).optional().describe('New description'),
          fromName: z.string().trim().max(200).regex(/^[^\r\n]*$/).optional().describe('Sender display name'),
          fromLocal: z.string().max(64).regex(/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]*$/).optional().describe('Sender email local part, before the domain'),
          replyTo: z.union([z.literal(''), z.email()]).optional().describe('Reply-to email address, or empty to use the sender'),
          postalAddress: z.string().trim().max(2000).optional().describe('Postal address included in every email'),
          language: z.string().min(2).max(35).refine((v) => { try { return Intl.getCanonicalLocales(v).length === 1 } catch { return false } }, 'Use a valid language code.').optional().describe('Newsletter language code'),
          timezone: z.string().max(100).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true } catch { return false } }, 'Use a valid timezone.').optional().describe('IANA timezone for scheduling'),
          doubleOptIn: z.boolean().optional().describe('Require email confirmation for public signups'),
          tracking: z.object({ opens: z.boolean(), clicks: z.boolean() }).optional().describe('Enable tracking for opens and clicks'),
        }),
        rest: { method: 'PATCH', path: '/newsletters/:newsletterId' },
        mcp: { title: 'Update a newsletter', destructive: false },
        handler: (ctx, input) => {
          const sets: string[] = []
          const values: (string | number)[] = []
          if (input.name !== undefined) {
            sets.push('name = ?')
            values.push(input.name)
          }
          if (input.description !== undefined) {
            sets.push('description = ?')
            values.push(input.description)
          }
          const extra = { fromName: 'from_name', fromLocal: 'from_local', replyTo: 'reply_to', postalAddress: 'postal_address', language: 'language', timezone: 'timezone', doubleOptIn: 'double_opt_in', tracking: 'tracking' } as const
          for (const key of Object.keys(extra) as (keyof typeof extra)[]) {
            const value = input[key]
            if (value !== undefined) {
              sets.push(extra[key] + ' = ?')
              values.push(typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value)
            }
          }
          if (sets.length) ctx.db.run(`UPDATE newsletters SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...values, ctx.now(), input.newsletterId)
          return getNewsletter(ctx, input.newsletterId)
        },
      }),
      defineAction({
        name: 'newsletters.setSlug',
        description: 'Change the public address of a newsletter. Old links stop working.',
        scope: 'account',
        role: 'admin',
        effect: 'write',
        resource: { type: 'newsletter', param: 'newsletterId' },
        input: z.object({ newsletterId, slug: slug.describe('The new slug') }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/slug' },
        mcp: { title: 'Change a newsletter address', destructive: true },
        handler: async (ctx, input) => {
          await assertSlugFree(ctx, input.slug, input.newsletterId)
          ctx.db.tx(() => {
            ctx.db.run('UPDATE newsletters SET slug = ?, updated_at = ? WHERE id = ?', input.slug, ctx.now(), input.newsletterId)
            syncDirectory(ctx, input.newsletterId)
          })
          return getNewsletter(ctx, input.newsletterId)
        },
      }),
      defineAction({
        name: 'newsletters.archive',
        description: 'Archive a newsletter. It leaves the switcher and its public site goes away.',
        scope: 'account',
        role: 'owner',
        effect: 'write',
        resource: { type: 'newsletter', param: 'newsletterId' },
        input: z.object({ newsletterId }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/archive' },
        mcp: { title: 'Archive a newsletter', destructive: true },
        handler: (ctx, input) => {
          ctx.db.tx(() => {
            ctx.db.run('UPDATE newsletters SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL', ctx.now(), ctx.now(), input.newsletterId)
            syncDirectory(ctx, input.newsletterId)
          })
          return getNewsletter(ctx, input.newsletterId)
        },
      }),
      defineAction({
        name: 'newsletters.unarchive',
        description: 'Bring an archived newsletter back.',
        scope: 'account',
        role: 'owner',
        effect: 'write',
        resource: { type: 'newsletter', param: 'newsletterId' },
        input: z.object({ newsletterId }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/unarchive' },
        mcp: { title: 'Unarchive a newsletter', destructive: false },
        handler: async (ctx, input) => {
          const row = getNewsletterRow(ctx, input.newsletterId)
          if (!row) throw notFound('That newsletter')
          if (row.archived_at) {
            const active = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM newsletters WHERE archived_at IS NULL')!.n
            if (active >= limits(ctx).maxNewsletters) throw new AppError('limit_reached', 'This account has reached its newsletter limit.', 403)
            await assertSlugFree(ctx, row.slug, row.id)
            ctx.db.tx(() => {
              ctx.db.run('UPDATE newsletters SET archived_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), input.newsletterId)
              syncDirectory(ctx, input.newsletterId)
            })
          }
          return getNewsletter(ctx, input.newsletterId)
        },
      }),
    )
  },
}
