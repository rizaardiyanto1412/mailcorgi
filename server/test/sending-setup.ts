/** Shared setup for the sending and tracking suites: a verified sender, a fast send rate and helpers to drive jobs. */
import type { StoreCtx } from '../core/store.ts'
import { subscribe, setContactStatus } from '../account/contacts/index.ts'
import { createInstall, type Install, type Client, type InstallOptions } from './harness.ts'

export const LINK_A = 'https://example.com/a'
export const LINK_B = 'https://example.com/b'

export async function sendableInstall(opts: InstallOptions = {}) {
  const install = await createInstall({ ...opts, env: { SEND_RATE_PER_SECOND: '1000', SEND_BATCH_SIZE: '200', ALLOWED_EMAILS: 'other@example.com', ...opts.env } })
  const owner = await install.signUp({ email: 'owner@example.com' })
  if (opts.cloud && !opts.env?.KEEP_PLAN) await install.app.stores.account(owner.accountId!).applyPolicy({ version: 1_000, status: 'active', plan: 'scale', limits: { maxContacts: null, maxEmailsPerMonth: null, maxNewsletters: null, maxTeamPerNewsletter: null } })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const domain = await owner.action('domains.add', { name: 'example.com' })
  install.dns.set('example.com', 'TXT', ['v=spf1 include:example.com ~all'])
  install.dns.set('_dmarc.example.com', 'TXT', ['v=DMARC1; p=none'])
  await owner.action('domains.check', { domainId: domain.id })
  await owner.action('newsletters.update', { newsletterId: nl.id, fromName: 'Weekly', fromLocal: 'news', domainId: domain.id, postalAddress: '1 Example Street' })
  const ctx = install.app.account(owner.accountId!).ctx
  return { install, owner, nl, ctx, accountId: owner.accountId! }
}

export function addContacts(ctx: StoreCtx, newsletterId: string, n: number, prefix = 'reader'): string[] {
  const ids: string[] = []
  ctx.db.tx(() => {
    for (let i = 0; i < n; i++) ids.push(subscribe(ctx, { newsletterId, email: `${prefix}${i}@example.com`, name: `Reader ${i}`, source: 'test', consent: 'confirmed' }).contact.id)
  })
  return ids
}

export const contactStatus = (ctx: StoreCtx, id: string, status: 'unsubscribed' | 'bounced' | 'complained' | 'cleaned') => setContactStatus(ctx, id, status)

export const issueDoc = (links: string[] = [LINK_A]) => ({ type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Hello {{first_name|reader}}, this is the issue.' }] },
  ...links.map((href, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Link ${i + 1}`, marks: [{ type: 'link', attrs: { href } }] }] })),
] })

export async function createIssue(owner: Client, newsletterId: string, extra: Record<string, unknown> = {}) {
  const draft = await owner.action('campaigns.create', { newsletterId, subject: 'Issue one', doc: issueDoc() as never, ...extra } as never)
  await owner.action('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'A preview' })
  return owner.action('campaigns.get', { campaignId: draft.id })
}

/** Run jobs and advance the clock a second at a time until the campaign leaves `sending`, or the cap is hit. */
export async function drive(install: Install, owner: Client, campaignId: string, opts: { maxSeconds?: number; stepMs?: number } = {}) {
  const max = opts.maxSeconds ?? 120
  for (let i = 0; i < max; i++) {
    await install.runJobs()
    const c = await owner.action('campaigns.get', { campaignId })
    if (c.status !== 'sending') return c
    install.clock.advance(opts.stepMs ?? 1000)
  }
  return owner.action('campaigns.get', { campaignId })
}

export const parseHeaders = (raw: string) => JSON.parse(raw) as Record<string, string>
export const tokensIn = (html: string, prefix: string) => [...html.matchAll(new RegExp(`${prefix.replace(/\//g, '\\/')}([A-Za-z0-9_.-]+)`, 'g'))].map((m) => m[1])
