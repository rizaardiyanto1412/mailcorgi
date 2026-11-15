import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { readOutbox } from '../../email/test.ts'
import type { ControlRegistrar } from '../rpc.ts'

/** Reads system emails (codes, invitations) from the test provider. Only with `MC_TEST_DNS` on, never in production. */
export const devModule = {
  name: 'dev',
  register(reg: ControlRegistrar) {
    reg.routes((app) => {
      app.get('/api/dev/code', (c) => {
        const ctx = c.get('ctx')
        if (!ctx.config.testDns) return c.json({ error: 'Not found.', code: 'not_found' }, 404)
        const to = (c.req.query('email') ?? '').trim().toLowerCase()
        const match = readOutbox(ctx, to).map((row) => /\b(\d{6})\b/.exec(row.text)?.[1]).filter(Boolean).at(-1)
        return match ? c.json({ code: match }) : c.json({ error: 'No code was emailed to that address.', code: 'not_found' }, 404)
      })
    })
    return reg.actions(
      defineAction({ name: 'dev.controlOutbox', description: 'Read system emails the test provider wrote. Dev mode only.', scope: 'control', role: 'installAdmin', effect: 'read', input: z.object({ to: z.string().trim().toLowerCase().optional().describe('Only emails sent to this address'), limit: z.number().int().min(1).max(200).default(50).describe('Newest emails to return') }), handler: (ctx, input) => {
        if (!ctx.config.testDns) throw new AppError('not_found', 'Not found.', 404)
        return { emails: readOutbox(ctx, input.to).slice(-input.limit).map((row) => ({ id: row.id, to: row.to_email, subject: row.subject, html: row.html, text: row.text, headers: JSON.parse(row.headers) as Record<string, string>, kind: row.kind, createdAt: row.created_at })) }
      } }),
    )
  },
}
