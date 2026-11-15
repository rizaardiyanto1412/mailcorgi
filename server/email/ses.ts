import type { StoreCtx } from '../core/store.ts'
import { AppError } from '../core/http.ts'
import type { EmailProvider } from './index.ts'

/** Built by the sending unit. Until then the install cannot select this provider. */
export function sesProvider(_ctx: StoreCtx, _settings: Record<string, string>): EmailProvider {
  throw new AppError('provider_not_configured', 'The ses email provider is not configured.', 501)
}
