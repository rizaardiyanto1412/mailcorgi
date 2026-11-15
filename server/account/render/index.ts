import { AppError } from '../../core/http.ts'
import type { AccountRegistrar } from '../rpc.ts'

export interface RecipientLinks {
  unsubscribe: string
  web: string
  preferences: string
  openPixel?: string
  wrap?(url: string): string
}
export interface RenderEmailInput {
  campaign: Record<string, unknown>
  newsletter: Record<string, unknown>
  theme: Record<string, unknown>
  recipient: { contact: Record<string, unknown>; links: RecipientLinks }
}
export interface RenderWebInput {
  campaign: Record<string, unknown>
  newsletter: Record<string, unknown>
  theme: Record<string, unknown>
  author?: Record<string, unknown>
}

const notBuilt = () => new AppError('not_built', 'Rendering is not built yet.', 501)

/** Pure functions, no DOM. Built by the render unit. */
export function renderEmail(_input: RenderEmailInput): { subject: string; html: string; text: string; headers: Record<string, string> } {
  throw notBuilt()
}
export function renderWeb(_input: RenderWebInput): { html: string; excerpt: string; image?: string } {
  throw notBuilt()
}
export function renderDocPreview(_doc: unknown, _theme: Record<string, unknown>): string {
  throw notBuilt()
}

export const renderModule = {
  name: 'render',
  register(_reg: AccountRegistrar) {},
}
