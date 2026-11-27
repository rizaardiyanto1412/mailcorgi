import { randomToken, toBase64 } from '../core/crypto.ts'
import type { EmailMessage } from './index.ts'

export class InvalidMessageError extends Error {}

export function safeHeader(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new InvalidMessageError('Invalid email header.')
  return value
}

export function encoded(value: string): string {
  safeHeader(value)
  if (/^[\x20-\x7e]*$/.test(value) && !value.includes('=?')) return value
  const chunks: string[] = []
  let chunk = ''
  for (const c of value) {
    if (new TextEncoder().encode(chunk + c).length > 42) {
      chunks.push(`=?UTF-8?B?${toBase64(new TextEncoder().encode(chunk))}?=`)
      chunk = ''
    }
    chunk += c
  }
  if (chunk) chunks.push(`=?UTF-8?B?${toBase64(new TextEncoder().encode(chunk))}?=`)
  return chunks.join(' ')
}

export function mailbox(value: string): string {
  safeHeader(value)
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(value)
  if (!match) return value
  const name = match[1].trim().replace(/^"|"$/g, '')
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encoded(name)
  return `${display} <${match[2]}>`
}

export function messageHeaders(msg: EmailMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(msg.headers)) {
    if (/^x-mc-(account|delivery)$/i.test(key)) continue
    if (!/^[A-Za-z0-9-]+$/.test(key) || /^(from|to|subject|reply-to|bcc|cc|content-.*|mime-version)$/i.test(key)) throw new InvalidMessageError('Invalid email header.')
    headers[key] = safeHeader(value)
  }
  headers['X-MC-Account'] = safeHeader(msg.meta.accountId)
  if (msg.meta.deliveryId) headers['X-MC-Delivery'] = safeHeader(msg.meta.deliveryId)
  return headers
}

function fold(name: string, value: string): string {
  let line = `${name}:`
  const lines: string[] = []
  for (const word of value.split(/\s+/)) {
    if (line.length + word.length + 1 > 78) {
      lines.push(line)
      line = ` ${word}`
    } else line += ` ${word}`
  }
  lines.push(line)
  if (lines.some((part) => part.length > 998)) throw new InvalidMessageError('Email header is too long.')
  return lines.join('\r\n')
}

export function buildMime(msg: EmailMessage): string {
  const boundary = `mc_${randomToken(18)}`
  const base64 = (body: string) => toBase64(new TextEncoder().encode(body.replace(/\r?\n/g, '\r\n'))).match(/.{1,76}/g)?.join('\r\n') ?? ''
  const content = msg.textOnly ? { 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': 'base64' } : { 'Content-Type': `multipart/alternative; boundary="${boundary}"` }
  const headers = { From: mailbox(msg.from), To: mailbox(msg.to), ...(msg.replyTo ? { 'Reply-To': mailbox(msg.replyTo) } : {}), Subject: encoded(msg.subject), ...messageHeaders(msg), 'MIME-Version': '1.0', ...content }
  const parts = Object.entries(headers).map(([name, value]) => fold(name, /[^\x20-\x7e]/.test(value) ? encoded(value) : value))
  // A plain send is one text/plain entity, the same shape a mail client writes.
  if (msg.textOnly) return [...parts, '', base64(msg.text), ''].join('\r\n')
  for (const [type, body] of [['text/plain', msg.text], ['text/html', msg.html]]) parts.push('', `--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64(body))
  parts.push(`--${boundary}--`, '')
  return parts.join('\r\n')
}
