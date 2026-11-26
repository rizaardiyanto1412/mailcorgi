import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { ControlRegistrar } from '../rpc.ts'
import { getSetting, getSettingSync, missingCredentials, PROVIDER_NAMES, TEST_EMAIL_KEY } from '../install/index.ts'

export type ChecklistState = 'done' | 'todo' | 'skipped'
export interface ChecklistItem {
  id: 'provider' | 'testEmail' | 'webhooks' | 'sending' | 'domain'
  state: ChecklistState
  detail: string
  href: string
}

/** Account stores asked per check. Self-hosted installs have a handful; cloud installs stop at the first hit. */
const ACCOUNTS_SCANNED = 50

const WEBHOOK_SETTING: Record<string, string> = { ses: 'ses_sns_topic_arn', resend: 'resend_webhook_secret', postshiba: 'postshiba_webhook_secret' }

async function accountFacts(ctx: StoreCtx) {
  const ids = ctx.db.all<{ id: string }>("SELECT id FROM accounts WHERE deleted_at IS NULL AND status != 'deleting' ORDER BY created_at, id LIMIT ?", ACCOUNTS_SCANNED)
  let verifiedDomains = 0
  let providerEvents = 0
  let lastProviderEventAt: number | null = null
  for (const { id } of ids) {
    if (verifiedDomains > 0 && providerEvents > 0) break
    try {
      const status = await ctx.stores.account(id).setupStatus({})
      verifiedDomains += status.verifiedDomains
      providerEvents += status.providerEvents
      if (status.lastProviderEventAt !== null) lastProviderEventAt = Math.max(lastProviderEventAt ?? 0, status.lastProviderEventAt)
    } catch {
      // A store that cannot answer right now does not block the rest of the checklist.
    }
  }
  return { verifiedDomains, providerEvents, lastProviderEventAt }
}

export async function setupChecklist(ctx: StoreCtx): Promise<{ provider: string; items: ChecklistItem[]; complete: boolean }> {
  const { provider, missing } = await missingCredentials(ctx)
  const name = PROVIDER_NAMES[provider]
  const configured = !!name && missing.length === 0

  let lastTest: { provider?: string; at?: number } = {}
  try {
    lastTest = JSON.parse(ctx.db.get<{ value: string }>('SELECT value FROM install_settings WHERE key = ?', TEST_EMAIL_KEY)?.value || '{}')
  } catch {}
  const tested = configured && lastTest.provider === provider

  const facts = await accountFacts(ctx)
  const webhookSetting = WEBHOOK_SETTING[provider]
  const webhookConfigured = webhookSetting ? !!(await getSetting(ctx, webhookSetting)) : false
  const sendingEnabled = getSettingSync(ctx, 'sending_enabled') !== 'false'

  const items: ChecklistItem[] = [
    {
      id: 'provider',
      state: configured ? 'done' : 'todo',
      detail: configured ? `${name} is configured.` : name ? `${name} is selected but ${missing.join(', ')} is not set.` : 'Emails go to the local test outbox. Choose Amazon SES, Resend, PostShiba or SMTP.',
      href: '/admin/email',
    },
    {
      id: 'testEmail',
      state: tested ? 'done' : 'todo',
      detail: tested ? `Sent through ${name} on ${new Date(lastTest.at ?? 0).toISOString().slice(0, 10)}.` : configured ? `Send a test email through ${name}.` : 'Configure a provider first.',
      href: '/admin/email',
    },
    provider === 'smtp'
      ? { id: 'webhooks', state: 'skipped', detail: 'SMTP reports no delivery events. Bounces and complaints are not tracked.', href: '/admin/email' }
      : {
          id: 'webhooks',
          state: facts.providerEvents > 0 ? 'done' : 'todo',
          detail: facts.providerEvents > 0
            ? `${facts.providerEvents} delivery events received.`
            : !name ? 'Configure Amazon SES, Resend or PostShiba first.' : webhookConfigured ? `Waiting for the first event from ${name}. Send a campaign to see one.` : `Add the ${name} webhook and save ${webhookSetting}.`,
          href: '/admin/email',
        },
    {
      id: 'sending',
      state: sendingEnabled ? 'done' : 'todo',
      detail: sendingEnabled ? 'Outbound email is on.' : 'Outbound email is paused for the whole install.',
      href: '/admin/email',
    },
    {
      id: 'domain',
      state: facts.verifiedDomains > 0 ? 'done' : 'todo',
      detail: facts.verifiedDomains > 0 ? `${facts.verifiedDomains} sending domain${facts.verifiedDomains === 1 ? '' : 's'} verified.` : 'Add a sending domain and publish its DNS records.',
      href: '/settings/domains',
    },
  ]
  return { provider, items, complete: items.every((item) => item.state !== 'todo') }
}

export const setupModule = {
  name: 'setup',
  register(reg: ControlRegistrar) {
    return reg.actions(
      defineAction({
        name: 'setup.checklist',
        description: 'Check what this install still needs before it can send newsletters: provider, test email, webhook events, sending switch and a verified domain.',
        scope: 'control',
        role: 'installAdmin',
        effect: 'read',
        input: z.object({}),
        handler: (ctx) => setupChecklist(ctx),
      }),
    )
  },
}
