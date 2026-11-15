import { z } from 'zod'
import { fromBase64 } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
export const imageShape = {
  contentType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).describe('The image MIME type'),
  data: z.string().min(1).max(2796204).describe('Base64-encoded image bytes, up to 2 MB'),
}
export function decodeImage(input: z.infer<z.ZodObject<typeof imageShape>>): Uint8Array {
  let bytes: Uint8Array
  try { bytes = fromBase64(input.data) } catch { throw new AppError('invalid_input', 'The image data is invalid.', 400) }
  const hex = Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
  const valid = input.contentType === 'image/png' ? hex.startsWith('89504e470d0a1a0a') : input.contentType === 'image/jpeg' ? hex.startsWith('ffd8ff') : input.contentType === 'image/gif' ? hex.startsWith('474946383761') || hex.startsWith('474946383961') : hex.startsWith('52494646') && hex.slice(16) === '57454250'
  if (!valid || bytes.length > 2097152) throw new AppError('invalid_input', 'Use a PNG, JPEG, GIF or WebP image under 2 MB.', 400)
  return bytes
}
