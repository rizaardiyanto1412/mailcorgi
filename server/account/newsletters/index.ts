import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { defineAction, type Actor } from '../../core/actions.ts'
import { AppError, notFound } from '../../core/http.ts'
import { websiteHost } from '../website/index.ts'
import { authorActions } from './authors.ts'
import { imageShape, decodeImage, deleteBrandingImage, queueImageRemoval } from './images.ts'
import { newId, newNewsletterKey } from '../../core/ids.ts'
import { themeSchema, themePatchSchema, mergeTheme, parseTheme, type Theme } from '../render/theme.ts'
import { limits } from '../usage/index.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { deleteNewsletterAction, registerNewsletterDelete } from './delete.ts'
import { migrations } from './migrations.ts'

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

const welcomeSchema = z.object({ enabled: z.boolean().default(false), transactional: z.boolean().default(false), includeListUnsubscribeHeaders: z.boolean().default(true) })
/** `newsletters.welcome`: whether the welcome email is on, and its two transactional switches. A value saved before they existed reads as not transactional, headers kept. */
export const welcomeOptions = (value: string) => welcomeSchema.parse(JSON.parse(value))
/**
 * The `transactional` render option for one email. Only the welcome email (`kind = 'welcome'`) of a
 * newsletter saved as transactional gets one; a campaign, sequence step or keep email gets undefined,
 * so it always carries its unsubscribe links and List-Unsubscribe headers. `headers` is false only
 * when the welcome email is transactional and `includeListUnsubscribeHeaders` was saved as false.
 */
export function transactionalWelcome(kind: string, newsletter: Pick<NewsletterRow, 'welcome'>): { headers: boolean } | undefined {
  if (kind !== 'welcome') return undefined
  const options = welcomeOptions(newsletter.welcome)
  return options.transactional ? { headers: options.includeListUnsubscribeHeaders } : undefined
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
  theme: Theme
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
  theme: themeSchema.parse(JSON.parse(r.theme)),
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
  const rows = ctx.db.all<NewsletterRow>(`SELECT * FROM newsletters WHERE deleting_at IS NULL ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY created_at`)
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

const slug = z.string().trim().toLowerCase().min(3).max(60).regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/, 'Use 3 to 60 letters, digits and dashes.')
const RESERVED_SLUGS = new Set(['api', 'admin', 'app', 'www', 'mail', 'n', 'f', 't', 'u', 'img', 'hooks', 'mcp', 'docs', 'static', 'assets', 'healthz', 'signin', 'signup', 'setup', 'welcome'])

function assertLocalSlugFree(ctx: StoreCtx, value: string, newsletterId: string | null) {
  const local = ctx.db.get<{ id: string }>('SELECT id FROM newsletters WHERE slug = ?', value)
  if (local && local.id !== newsletterId) throw new AppError('slug_taken', 'That address is already in use.', 409)
}

async function assertSlugFree(ctx: StoreCtx, value: string, newsletterId: string | null) {
  if (RESERVED_SLUGS.has(value)) throw new AppError('slug_taken', 'That address is reserved.', 409)
  assertLocalSlugFree(ctx, value, newsletterId)
  const site = await ctx.stores.control.lookupSite({ slug: value })
  if (site && site.newsletter_id !== newsletterId) throw new AppError('slug_taken', 'That address is already in use.', 409)
}

const syncDirectory = (ctx: StoreCtx, newsletterId: string) => ctx.jobs.enqueue('directory.sync', { newsletterId }, { dedupeKey: `directory.sync:${newsletterId}` })

const newsletterId = z.string().min(1).describe('The newsletter id')

const newsletterLimitError = (ctx: StoreCtx, used: number) => new AppError('limit_reached', `This account has reached its newsletter limit: ${used} of ${limits(ctx).maxNewsletters} active newsletters. Archive one or change your plan.`, 403, { resource: 'newsletters', used, limit: limits(ctx).maxNewsletters })

export const newslettersModule = {
  name: 'newsletters',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    registerNewsletterDelete(reg)
    reg.job<{ newsletterId: string; key: string }>('newsletters.deleteImage', deleteBrandingImage)
    // A newsletter being deleted no longer exists for actions; its rows are going away.
    reg.resolver('newsletter', (ctx, id) => (ctx.db.get('SELECT id FROM newsletters WHERE id = ? AND deleting_at IS NULL', id) ? id : null))
    reg.resolver('author', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM authors WHERE id = ?', id)?.newsletter_id ?? null)

    reg.job<{ newsletterId: string }>('directory.sync', async (ctx, { newsletterId }) => {
      const row = getNewsletterRow(ctx, newsletterId)
      const accountId = ctx.accountId!
      if (!row || row.archived_at !== null) await ctx.stores.control.removeSite({ newsletterId, accountId })
      else {
        const host = websiteHost(ctx, newsletterId)
        await ctx.stores.control.upsertSite({ newsletterId, accountId, slug: row.slug, customHost: host?.hostname ?? null, hostVerifiedAt: host?.verified_at ?? null })
      }
      return 'done'
    })

    return reg.actions(
      ...authorActions,
      deleteNewsletterAction,
      defineAction({
        name: 'newsletters.uploadImage', description: 'Upload a newsletter logo or icon as PNG, JPEG, GIF or WebP, up to 2 MB.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' },
        input: z.object({ newsletterId, kind: z.enum(['logo', 'icon']).describe('Which newsletter image to replace'), ...imageShape }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/branding/images' }, mcp: { title: 'Upload a newsletter image', destructive: false },
        handler: async (ctx, i, actor) => {
          const bytes = decodeImage(i)
          const key = newId('img')
          const fullKey = `${ctx.accountId}/${key}`
          await ctx.platform.blobs.put(fullKey, bytes, i.contentType)
          try {
            ctx.db.tx(() => {
              ctx.db.run('INSERT INTO uploads (key, newsletter_id, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', fullKey, i.newsletterId, i.contentType, bytes.length, actor.userId, ctx.now())
              const old = ctx.db.get<{ logo_key: string | null; icon_key: string | null }>('SELECT logo_key, icon_key FROM newsletters WHERE id = ?', i.newsletterId)
              ctx.db.run(`UPDATE newsletters SET ${i.kind === 'logo' ? 'logo_key' : 'icon_key'} = ?, updated_at = ? WHERE id = ?`, key, ctx.now(), i.newsletterId)
              queueImageRemoval(ctx, i.newsletterId, (i.kind === 'logo' ? old?.logo_key : old?.icon_key) ?? null)
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
          if (active >= limits(ctx).maxNewsletters) throw newsletterLimitError(ctx, active)
          const wanted = input.slug ?? slugify(input.name)
          if (wanted.length < 3) throw new AppError('invalid_input', 'slug: Use 3 to 60 letters, digits and dashes.', 400)
          await assertSlugFree(ctx, wanted, null)
          const id = newId('nl')
          const now = ctx.now()
          ctx.db.tx(() => {
            {
              const live = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM newsletters WHERE archived_at IS NULL')!.n
              if (live >= limits(ctx).maxNewsletters) throw newsletterLimitError(ctx, live)
            }
            assertLocalSlugFree(ctx, wanted, null)
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
          domainId: z.string().min(1).nullable().optional().describe('Verified sender domain id, or null to clear the sender'),
          replyTo: z.union([z.literal(''), z.email()]).optional().describe('Reply-to email address, or empty to use the sender'),
          postalAddress: z.string().trim().max(2000).optional().describe('Postal address included in every email'),
          language: z.string().min(2).max(35).refine((v) => { try { return Intl.getCanonicalLocales(v).length === 1 } catch { return false } }, 'Use a valid language code.').optional().describe('Newsletter language code'),
          timezone: z.string().max(100).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true } catch { return false } }, 'Use a valid timezone.').optional().describe('IANA timezone for scheduling'),
          doubleOptIn: z.boolean().optional().describe('Require email confirmation for public signups'),
          tracking: z.object({ opens: z.boolean().optional(), clicks: z.boolean().optional() }).optional().describe('Enable tracking for opens and clicks. An omitted key keeps its current value.'),
          theme: themePatchSchema.optional().describe('Email and website colors, fonts, headings, buttons, header and footer. Omitted keys (and omitted header keys) keep their saved value.'),
        }),
        rest: { method: 'PATCH', path: '/newsletters/:newsletterId' },
        mcp: { title: 'Update a newsletter', destructive: false },
        handler: (ctx, input) => {
          if (input.domainId != null && !ctx.db.get("SELECT id FROM domains WHERE id = ? AND status = 'verified'", input.domainId)) throw new AppError('domain_unverified', 'Choose a verified sending domain.', 400)
          const sets: string[] = []
          if (input.domainId !== undefined) {
            sets.push('domain_id = ?')
          }
          const values: (string | number | null)[] = input.domainId !== undefined ? [input.domainId] : []
          if (input.name !== undefined) {
            sets.push('name = ?')
            values.push(input.name)
          }
          if (input.description !== undefined) {
            sets.push('description = ?')
            values.push(input.description)
          }
          const stored = input.theme || input.tracking ? getNewsletterRow(ctx, input.newsletterId) : undefined
          const tracking = input.tracking && stored ? { ...z.object({ opens: z.boolean().default(true), clicks: z.boolean().default(true) }).parse(JSON.parse(stored.tracking)), ...Object.fromEntries(Object.entries(input.tracking).filter(([, v]) => v !== undefined)) } : undefined
          const theme = input.theme && stored ? mergeTheme(parseTheme(stored.theme), input.theme) : undefined
          const extra: [string, string | boolean | Theme | { opens: boolean; clicks: boolean } | undefined][] = [
            ['from_name', input.fromName], ['from_local', input.fromLocal], ['reply_to', input.replyTo],
            ['postal_address', input.postalAddress], ['language', input.language], ['timezone', input.timezone],
            ['double_opt_in', input.doubleOptIn], ['tracking', tracking], ['theme', theme],
          ]
          for (const [column, value] of extra) {
            if (value !== undefined) {
              sets.push(column + ' = ?')
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
            assertLocalSlugFree(ctx, input.slug, input.newsletterId)
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
          if (row.archived_at !== null) {
            const active = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM newsletters WHERE archived_at IS NULL')!.n
            if (active >= limits(ctx).maxNewsletters) throw newsletterLimitError(ctx, active)
            await assertSlugFree(ctx, row.slug, row.id)
            ctx.db.tx(() => {
              const current = getNewsletterRow(ctx, input.newsletterId)
              if (!current || current.archived_at === null) return
              {
              const live = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM newsletters WHERE archived_at IS NULL')!.n
              if (live >= limits(ctx).maxNewsletters) throw newsletterLimitError(ctx, live)
            }
              assertLocalSlugFree(ctx, row.slug, row.id)
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
