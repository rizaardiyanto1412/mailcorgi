import { imageShape, decodeImage, queueImageRemoval } from './images.ts'
import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { newId } from '../../core/ids.ts'
import { AppError, notFound } from '../../core/http.ts'
const newsletterId = z.string().min(1).describe('The newsletter id')
const authorId = z.string().min(1).describe('The author id')
const shape = {
  name: z.string().trim().min(1).max(120).describe('The author name'),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/).describe('The author public address slug'),
  bio: z.string().trim().max(2000).describe('A short author biography'),
  links: z.record(z.string().max(50), z.url().refine((v) => /^https?:\/\//.test(v), 'Use an http or https URL.')).describe('Named links for the author'),
}
interface AuthorRow { id: string; name: string; slug: string; bio: string; links: string; avatar_key: string | null }
const serialize = (r: AuthorRow) => ({ id: r.id, name: r.name, slug: r.slug, bio: r.bio, links: z.record(z.string(), z.string()).parse(JSON.parse(r.links)), avatarKey: r.avatar_key })
export const authorActions = [
  defineAction({ name: 'authors.uploadAvatar', description: 'Upload an author avatar as PNG, JPEG, GIF or WebP, up to 2 MB.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'author', param: 'authorId' }, input: z.object({ newsletterId, authorId, ...imageShape }), rest: { method: 'POST', path: '/newsletters/:newsletterId/authors/:authorId/avatar' }, mcp: { title: 'Upload an author avatar', destructive: false }, handler: async (ctx, i, actor) => {
    const bytes = decodeImage(i)
    const key = newId('img')
    const fullKey = `${ctx.accountId}/${key}`
    await ctx.platform.blobs.put(fullKey, bytes, i.contentType)
    try {
      ctx.db.tx(() => {
        ctx.db.run('INSERT INTO uploads (key, newsletter_id, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', fullKey, i.newsletterId, i.contentType, bytes.length, actor.userId, ctx.now())
        const old = ctx.db.get<{ avatar_key: string | null }>('SELECT avatar_key FROM authors WHERE id = ? AND newsletter_id = ?', i.authorId, i.newsletterId)
        if (!old || !ctx.db.run('UPDATE authors SET avatar_key = ? WHERE id = ? AND newsletter_id = ?', key, i.authorId, i.newsletterId).changes) throw notFound('That author')
        queueImageRemoval(ctx, i.newsletterId, old.avatar_key)
      })
    } catch (error) { await ctx.platform.blobs.delete(fullKey); throw error }
    return { avatarKey: key }
  } }),
  defineAction({ name: 'authors.list', description: 'List newsletter authors.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/authors' }, mcp: { title: 'List authors', destructive: false }, handler: (ctx, i) => ({ authors: ctx.db.all<AuthorRow>('SELECT * FROM authors WHERE newsletter_id = ? ORDER BY name, id', i.newsletterId).map(serialize) }) }),
  defineAction({ name: 'authors.create', description: 'Add a newsletter author.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, ...shape, bio: shape.bio.default('').describe('A short author biography'), links: shape.links.default({}).describe('Named links for the author') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/authors' }, mcp: { title: 'Add an author', destructive: false }, handler: (ctx, i) => {
    if (ctx.db.get('SELECT id FROM authors WHERE newsletter_id = ? AND slug = ?', i.newsletterId, i.slug)) throw new AppError('already_exists', 'That author address is already in use.', 409)
    const id = newId('au')
    ctx.db.run('INSERT INTO authors (id, newsletter_id, name, slug, bio, links, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, i.newsletterId, i.name, i.slug, i.bio, JSON.stringify(i.links), ctx.now())
    return { id, name: i.name, slug: i.slug, bio: i.bio, links: i.links, avatarKey: null }
  } }),
  defineAction({ name: 'authors.update', description: 'Edit a newsletter author. Omitted fields keep their saved value.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'author', param: 'authorId' }, input: z.object({ newsletterId, authorId, name: shape.name.optional().describe(shape.name.description!), slug: shape.slug.optional().describe(shape.slug.description!), bio: shape.bio.optional().describe(shape.bio.description!), links: shape.links.optional().describe(shape.links.description! + '; replaces all links') }), rest: { method: 'PATCH', path: '/newsletters/:newsletterId/authors/:authorId' }, mcp: { title: 'Edit an author', destructive: false }, handler: (ctx, i) => {
    const old = ctx.db.get<AuthorRow>('SELECT * FROM authors WHERE id = ? AND newsletter_id = ?', i.authorId, i.newsletterId)
    if (!old) throw notFound('That author')
    const slug = i.slug ?? old.slug
    if (ctx.db.get('SELECT id FROM authors WHERE newsletter_id = ? AND slug = ? AND id != ?', i.newsletterId, slug, i.authorId)) throw new AppError('already_exists', 'That author address is already in use.', 409)
    ctx.db.run('UPDATE authors SET name = ?, slug = ?, bio = ?, links = ? WHERE id = ? AND newsletter_id = ?', i.name ?? old.name, slug, i.bio ?? old.bio, i.links ? JSON.stringify(i.links) : old.links, i.authorId, i.newsletterId)
    const r = ctx.db.get<AuthorRow>('SELECT * FROM authors WHERE id = ? AND newsletter_id = ?', i.authorId, i.newsletterId)
    if (!r) throw notFound('That author')
    return serialize(r)
  } }),
  defineAction({ name: 'authors.delete', description: 'Delete a newsletter author.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'author', param: 'authorId' }, input: z.object({ newsletterId, authorId }), rest: { method: 'DELETE', path: '/newsletters/:newsletterId/authors/:authorId' }, mcp: { title: 'Delete an author', destructive: true }, handler: (ctx, i) => ctx.db.tx(() => {
    const old = ctx.db.get<{ avatar_key: string | null }>('SELECT avatar_key FROM authors WHERE id = ? AND newsletter_id = ?', i.authorId, i.newsletterId)
    ctx.db.run('DELETE FROM authors WHERE id = ? AND newsletter_id = ?', i.authorId, i.newsletterId)
    queueImageRemoval(ctx, i.newsletterId, old?.avatar_key ?? null)
    return { deleted: true }
  }) }),
] as const
