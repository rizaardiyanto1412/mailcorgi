/** WebCrypto only, so the same code runs on Workers and Node. */
const enc = new TextEncoder()
const dec = new TextDecoder()

export const toBytes = (value: string | Uint8Array) => (typeof value === 'string' ? enc.encode(value) : value)

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
export function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export const toBase64Url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return fromBase64(padded)
}
export const encodeJsonUrl = (value: unknown) => toBase64Url(enc.encode(JSON.stringify(value)))
export function decodeJsonUrl<T>(text: string): T | null {
  try {
    return JSON.parse(dec.decode(fromBase64Url(text))) as T
  } catch {
    return null
  }
}

export const randomHex = (bytes = 32) => toHex(randomBytes(bytes))
export const randomToken = (bytes = 32) => toBase64Url(randomBytes(bytes))

export async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(value) as BufferSource))
}
export const sha256Hex = async (value: string | Uint8Array) => toHex(await sha256(value))

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function hmac(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, toBytes(data) as BufferSource))
}

export async function hkdf(master: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', master as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('mailcorgi'), info: enc.encode(info) }, k, length * 8)
  return new Uint8Array(bits)
}

/** Workers cap PBKDF2 at 100,000 iterations. */
const PBKDF2_ITERATIONS = 100_000

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toBase64(salt)}:${toBase64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split(':')
  if (scheme !== 'pbkdf2' || !iterations || !salt || !hash) return false
  const expected = fromBase64(hash)
  const actual = await pbkdf2(password, fromBase64(salt), Number(iterations), expected.length)
  return timingSafeEqual(expected, actual)
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, length = 32): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, k, length * 8))
}

/** AES-GCM. Format: v1:<iv>:<ciphertext+tag>, base64. */
export async function encrypt(key: Uint8Array, plain: string): Promise<string> {
  if (!plain) return ''
  const iv = randomBytes(12)
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt'])
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, k, enc.encode(plain)))
  return `v1:${toBase64(iv)}:${toBase64(data)}`
}

export async function decrypt(key: Uint8Array, stored: string | null | undefined): Promise<string> {
  if (!stored) return ''
  const [v, iv, data] = stored.split(':')
  if (v !== 'v1' || !iv || !data) return ''
  try {
    const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt'])
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) as BufferSource }, k, fromBase64(data) as BufferSource))
  } catch {
    return ''
  }
}

/** Every key the app uses, derived from one master secret. */
export interface Keys {
  master: string
  session: Uint8Array
  credentials: Uint8Array
  suppression: Uint8Array
  tokenKey(accountId: string): Promise<Uint8Array>
}

export async function deriveKeys(master: string): Promise<Keys> {
  const bytes = enc.encode(master)
  const cache = new Map<string, Promise<Uint8Array>>()
  return {
    master,
    session: await hkdf(bytes, 'session-signing'),
    credentials: await hkdf(bytes, 'credential-encryption'),
    suppression: await hkdf(bytes, 'suppression-hashing'),
    tokenKey(accountId) {
      let p = cache.get(accountId)
      if (!p) {
        p = hkdf(bytes, `token:${accountId}`)
        cache.set(accountId, p)
      }
      return p
    },
  }
}

/** A 6-digit code for sign-up, sign-in and reset emails. */
export function randomCode(): string {
  const n = new Uint32Array(1)
  crypto.getRandomValues(n)
  return String(n[0] % 1_000_000).padStart(6, '0')
}

/** Signed envelope: base64url JSON + "." + base64url HMAC. */
export async function signEnvelope(key: Uint8Array, payload: unknown): Promise<string> {
  const body = encodeJsonUrl(payload)
  return `${body}.${toBase64Url(await hmac(key, body))}`
}
export async function openEnvelope<T>(key: Uint8Array, envelope: string | null | undefined): Promise<T | null> {
  if (!envelope) return null
  const dot = envelope.lastIndexOf('.')
  if (dot < 0) return null
  const body = envelope.slice(0, dot)
  const sig = envelope.slice(dot + 1)
  let given: Uint8Array
  try {
    given = fromBase64Url(sig)
  } catch {
    return null
  }
  if (!timingSafeEqual(given, await hmac(key, body))) return null
  return decodeJsonUrl<T>(body)
}
