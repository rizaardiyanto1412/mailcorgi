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
