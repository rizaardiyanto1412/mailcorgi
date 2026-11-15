import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { randomBase32 } from '../../core/ids.ts'

const MAX_BYTES = 5 * 1024 * 1024
function imageType(bytes: Uint8Array): {
  ext: string
  contentType: string
} | null {
  const starts = (magic: number[]) => magic.every((b, i) => bytes[i] === b)
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return { ext: 'png', contentType: 'image/png' }
  if (starts([255, 216, 255])) return { ext: 'jpg', contentType: 'image/jpeg' }
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end))
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { ext: 'gif', contentType: 'image/gif' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', contentType: 'image/webp' }
  return null
}
export const uploadImageAction = defineAction({
  name: 'campaigns.uploadImage', description: 'Upload an image up to 5 MB. PNG, JPEG, GIF and WebP are supported.', scope: 'account', role: 'member', effect: 'write',
  resource: { type: 'newsletter', param: 'newsletterId' },
  input: z.object({
    newsletterId: z.string().min(1).describe('The newsletter that owns the image'),
    data: z.string().max(Math.ceil(MAX_BYTES / 3) * 4).describe('Base64-encoded image bytes without a data URL prefix'),
    width: z.number().int().min(1).max(20000).describe('Image width in pixels'),
    height: z.number().int().min(1).max(20000).describe('Image height in pixels'),
  }),
  rest: { method: 'POST', path: '/newsletters/:newsletterId/images' },
  mcp: { title: 'Upload a newsletter image', destructive: false },
  handler: async (ctx, input, actor) => {
    let bytes: Uint8Array
    try {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error()
      bytes = Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0))
    } catch { throw new AppError('invalid_image', 'The image data is invalid.', 400) }
    if (!bytes.length || bytes.length > MAX_BYTES) throw new AppError('image_size', 'Images must be no larger than 5 MB.', 400)
    const type = imageType(bytes)
    if (!type) throw new AppError('image_type', 'Choose a PNG, JPEG, GIF or WebP image.', 400)
    const key = `${input.newsletterId}/${randomBase32(24)}.${type.ext}`
    const fullKey = `${ctx.accountId}/${key}`
    await ctx.platform.blobs.put(fullKey, bytes, type.contentType)
    try {
      ctx.db.run('INSERT INTO uploads (key, newsletter_id, content_type, bytes, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', key, input.newsletterId, type.contentType, bytes.length, input.width, input.height, actor.userId, ctx.now())
    } catch (error) {
      await ctx.platform.blobs.delete(fullKey)
      throw error
    }
    const base = ctx.config.imagesPublicUrl || `${ctx.config.appUrl}/img`
    return { key, url: `${base}/${ctx.accountId}/${key}`, width: input.width, height: input.height, bytes: bytes.length, contentType: type.contentType }
  },
})

const imageId = z.string().regex(/^[a-z0-9]{8,64}\.(png|jpg|gif|webp)$/).describe('The image file name, as returned by the image list')
const imageUrl = (ctx: { config: { imagesPublicUrl: string; appUrl: string }; accountId: string | null }, key: string) => `${ctx.config.imagesPublicUrl || `${ctx.config.appUrl}/img`}/${ctx.accountId}/${key}`
interface UploadRow { key: string; content_type: string; bytes: number; width: number | null; height: number | null; created_at: number }

/** Campaigns and newsletter settings whose content mentions this image. `instr`, not LIKE: ids contain `_`. */
export function imageUsage(ctx: { db: import('../../core/db.ts').Db }, newsletterId: string, key: string) {
  const campaigns = ctx.db.all<{ id: string; subject: string; status: string; kind: string }>(
    "SELECT id, subject, status, kind FROM campaigns WHERE newsletter_id = ? AND (instr(COALESCE(doc, ''), ?) > 0 OR instr(COALESCE(html, ''), ?) > 0 OR instr(COALESCE(source, ''), ?) > 0) ORDER BY created_at DESC LIMIT 20",
    newsletterId, key, key, key,
  )
  const settings = !!ctx.db.get("SELECT id FROM newsletters WHERE id = ? AND (instr(welcome, ?) > 0 OR instr(website, ?) > 0 OR instr(theme, ?) > 0)", newsletterId, key, key, key)
  return { campaigns: campaigns.map((c) => ({ id: c.id, subject: c.subject, status: c.status, kind: c.kind })), settings }
}

export const listImagesAction = defineAction({
  name: 'campaigns.listImages', description: 'List images uploaded for this newsletter’s campaigns, newest first.', scope: 'account', role: 'member', effect: 'read',
  resource: { type: 'newsletter', param: 'newsletterId' },
  input: z.object({
    newsletterId: z.string().min(1).describe('The newsletter that owns the images'),
    cursor: z.string().max(200).optional().describe('The `next` value from the previous page'),
    limit: z.number().int().min(1).max(100).default(48).describe('Images per page'),
  }),
  rest: { method: 'GET', path: '/newsletters/:newsletterId/images' },
  mcp: { title: 'List newsletter images', destructive: false },
  handler: (ctx, input) => {
    const [at, after] = (input.cursor ?? '').split('|')
    const cursor = input.cursor && Number.isFinite(Number(at)) ? { at: Number(at), key: after ?? '' } : null
    const prefix = `${input.newsletterId}/`
    const rows = ctx.db.all<UploadRow>(
      `SELECT key, content_type, bytes, width, height, created_at FROM uploads WHERE newsletter_id = ? AND substr(key, 1, ?) = ?${cursor ? ' AND (created_at < ? OR (created_at = ? AND key < ?))' : ''} ORDER BY created_at DESC, key DESC LIMIT ?`,
      input.newsletterId, prefix.length, prefix, ...(cursor ? [cursor.at, cursor.at, cursor.key] : []), input.limit + 1,
    )
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      images: page.map((r) => ({ id: r.key.slice(prefix.length), url: imageUrl(ctx, r.key), contentType: r.content_type, bytes: r.bytes, width: r.width, height: r.height, createdAt: r.created_at })),
      next: rows.length > input.limit && last ? `${last.created_at}|${last.key}` : null,
    }
  },
})

export const deleteImageAction = defineAction({
  name: 'campaigns.deleteImage', description: 'Delete an uploaded image from storage. Emails already sent show a broken image where they used it. When a campaign still uses the image, nothing is deleted unless `confirm` is true; the error lists where it is used.', scope: 'account', role: 'admin', effect: 'write',
  resource: { type: 'newsletter', param: 'newsletterId' },
  input: z.object({
    newsletterId: z.string().min(1).describe('The newsletter that owns the image'),
    imageId,
    confirm: z.boolean().default(false).describe('Delete even though a campaign or the newsletter settings still use the image'),
  }),
  rest: { method: 'DELETE', path: '/newsletters/:newsletterId/images/:imageId' },
  mcp: { title: 'Delete a newsletter image', destructive: true },
  handler: async (ctx, input) => {
    const key = `${input.newsletterId}/${input.imageId}`
    if (!ctx.db.get('SELECT key FROM uploads WHERE key = ? AND newsletter_id = ?', key, input.newsletterId)) throw new AppError('not_found', 'Image not found.', 404)
    const usage = imageUsage(ctx, input.newsletterId, key)
    if (!input.confirm && (usage.campaigns.length || usage.settings)) throw new AppError('image_in_use', 'This image is still used. Delete it anyway to leave a broken image there.', 409, usage)
    // Blob first: if storage fails the row stays, so the delete can be retried instead of leaking the file.
    await ctx.platform.blobs.delete(`${ctx.accountId}/${key}`)
    ctx.db.run('DELETE FROM uploads WHERE key = ? AND newsletter_id = ?', key, input.newsletterId)
    return { ok: true, usage }
  },
})
