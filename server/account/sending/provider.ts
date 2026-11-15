import type { StoreCtx } from '../../core/store.ts'
import { providerFromSettings, providerSettings, type EmailProvider } from '../../email/index.ts'

/** Tests swap the provider here to simulate refusals, throttling and lost results. Null in production. */
export const sendHooks: { provider: ((ctx: StoreCtx, settings: Record<string, string>) => EmailProvider) | null } = { provider: null }

export async function sendSettings(ctx: StoreCtx): Promise<Record<string, string>> {
  return providerSettings(ctx)
}
export async function sendProvider(ctx: StoreCtx, settings: Record<string, string>): Promise<EmailProvider> {
  return sendHooks.provider ? sendHooks.provider(ctx, settings) : providerFromSettings(ctx, settings)
}
