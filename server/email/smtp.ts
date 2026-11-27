import type { StoreCtx } from '../core/store.ts'
import type { EmailProvider } from './index.ts'
import { buildMime, InvalidMessageError } from './mime.ts'
import { invalidSend, failedSend } from './http.ts'
import { z } from 'zod'

export function smtpProvider(_ctx: StoreCtx, settings: Record<string, string>): EmailProvider {
  return {
    name: 'smtp', capabilities: { identities: false, events: false, idempotency: false },
    async send(msg) {
      if (!('process' in globalThis) || typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') return { ok: false, kind: 'permanent', message: 'SMTP needs the Node build. Choose SES, Resend or PostShiba on Workers.' }
      try {
        const packageName = 'nodemailer'
        const loaded: typeof import('nodemailer') = await import(packageName)
        const nodemailer = loaded.default
        const transport = nodemailer.createTransport({ host: settings.smtp_host, port: Number(settings.smtp_port || '587'), secure: settings.smtp_security === 'tls', requireTLS: settings.smtp_security !== 'none', auth: settings.smtp_user ? { user: settings.smtp_user, pass: settings.smtp_password } : undefined, connectionTimeout: 15_000, socketTimeout: 30_000 })
        try {
          const address = (s: string) => /<([^<>]+)>/.exec(s)?.[1] ?? s
          const result = await transport.sendMail({ envelope: { from: address(msg.from), to: [address(msg.to)] }, raw: buildMime(msg) })
          return { ok: true, id: result.messageId }
        } finally { transport.close() }
      } catch (error) {
        if (error instanceof InvalidMessageError) return invalidSend()
        const parsed = z.object({ responseCode: z.number().optional(), code: z.string().optional() }).safeParse(error)
        if (parsed.success && parsed.data.responseCode) return { ok: false, kind: parsed.data.responseCode >= 500 ? 'permanent' : parsed.data.responseCode === 421 || parsed.data.responseCode === 450 ? 'throttled' : 'temporary', message: `SMTP refused the message (${parsed.data.responseCode}).` }
        if (parsed.success && parsed.data.code === 'EAUTH') return { ok: false, kind: 'permanent', message: 'SMTP authentication failed.' }
        return failedSend('smtp', error, [settings.smtp_password, settings.smtp_user], msg.safeDiagnostics)
      }
    },
  }
}
