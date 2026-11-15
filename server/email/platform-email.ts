import type { StoreCtx } from '../core/store.ts'
import { randomToken } from '../core/crypto.ts'
import { AppError } from '../core/http.ts'
import { providerFromSettings, PROVIDER_SETTING_KEYS, type SendResult } from './index.ts'

export interface SystemEmail {
  to: string
  subject: string
  html: string
  text: string
  kind: string
  replyTo?: string
}

/** Read provider settings from this store when it is the control store, else over RPC. */
export async function providerSettings(ctx: StoreCtx): Promise<Record<string, string>> {
  if (ctx.kind === 'control') {
    const { getSettings } = await import('../control/install/index.ts')
    return getSettings(ctx, [...PROVIDER_SETTING_KEYS])
  }
  return ctx.stores.control.getInstallSettings({ keys: [...PROVIDER_SETTING_KEYS] })
}

/** The address system emails come from. */
export function systemFrom(ctx: StoreCtx, settings: Record<string, string>): string {
  const host = (() => {
    try {
      return ctx.config.appUrl ? new URL(ctx.config.appUrl).hostname : 'localhost'
    } catch {
      return 'localhost'
    }
  })()
  const address = settings.email_from || `mailcorgi@${host}`
  const name = settings.email_from_name || 'MailCorgi'
  return `${name.replace(/[<>"]/g, '')} <${address}>`
}

/** Codes, invites and alerts go out through the same provider as campaigns. */
export async function sendSystemEmail(ctx: StoreCtx, mail: SystemEmail): Promise<SendResult> {
  const settings = await providerSettings(ctx)
  const provider = await providerFromSettings(ctx, settings)
  const result = await provider.send({
    from: systemFrom(ctx, settings),
    to: mail.to,
    replyTo: mail.replyTo,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: { 'X-MC-Account': ctx.accountId ?? 'control', 'Auto-Submitted': 'auto-generated' },
    meta: { accountId: ctx.accountId ?? 'control', deliveryId: null, kind: 'system' },
    idempotencyKey: randomToken(12),
  })
  if (!result.ok && result.kind === 'permanent') throw new AppError('email_failed', `The email could not be sent: ${result.message}`, 502)
  return result
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** A plain, short email: a heading, a few lines and maybe a big code. */
export function simpleEmail(input: { title: string; lines: string[]; code?: string; link?: { label: string; url: string } }): { html: string; text: string } {
  const parts = [`<h2 style="margin:0 0 12px;font:600 18px/1.3 -apple-system,Segoe UI,Roboto,sans-serif">${escape(input.title)}</h2>`]
  for (const line of input.lines) parts.push(`<p style="margin:0 0 10px;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">${escape(line)}</p>`)
  if (input.code) parts.push(`<p style="margin:16px 0;font:700 28px/1 ui-monospace,Menlo,monospace;letter-spacing:4px">${escape(input.code)}</p>`)
  if (input.link) parts.push(`<p style="margin:16px 0"><a href="${escape(input.link.url)}" style="font:600 15px -apple-system,Segoe UI,Roboto,sans-serif">${escape(input.link.label)}</a></p>`)
  const text = [input.title, '', ...input.lines, input.code ? `\n${input.code}` : '', input.link ? `\n${input.link.label}: ${input.link.url}` : ''].filter((s) => s !== '').join('\n')
  return { html: `<div style="max-width:520px;margin:0 auto;padding:24px">${parts.join('')}</div>`, text }
}
