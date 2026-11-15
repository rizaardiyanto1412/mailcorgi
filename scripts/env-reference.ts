/**
 * The environment variable reference in docs/self-hosting.md.
 *
 *   npx tsx scripts/env-reference.ts           rewrite the table between the markers
 *   npx tsx scripts/env-reference.ts --check   exit 1 when the table or this file is stale
 *
 * `readEnvNames()` finds every variable the server and Worker read, including install settings that
 * an env var overrides (`getSetting(ctx, 'ses_region')` reads `SES_REGION`). server/test/env-reference.test.ts
 * fails when a name is read but not described here, or described here but never read.
 */
import fs from 'node:fs'
import path from 'node:path'

type Platform = 'both' | 'node' | 'cloudflare'
export interface EnvVar {
  name: string
  group: 'Core' | 'Email' | 'Billing (cloud mode)' | 'Websites' | 'Platform'
  platform: Platform
  default?: string
  secret?: boolean
  description: string
}

export const ENV_VARS: EnvVar[] = [
  { name: 'APP_URL', group: 'Core', platform: 'both', default: 'learned from the first sign-in', description: 'Public address of the install, for example `https://news.example.com`. Links in emails and secure cookies use it.' },
  { name: 'CLOUD', group: 'Core', platform: 'both', default: 'off', description: '`true` turns on cloud mode: open sign-up with emailed codes, plans, limits and billing.' },
  { name: 'ADMIN_EMAILS', group: 'Core', platform: 'both', description: 'Comma-separated install admins. They may always sign up, see `/admin` and get admin alerts by email. Admin rights start only after the address is confirmed with an emailed code or an invite link.' },
  { name: 'ALLOWED_EMAILS', group: 'Core', platform: 'both', description: 'Comma-separated addresses that may sign up on a self-hosted install with an emailed code. Adds to the list in **Admin → Settings**.' },
  { name: 'SIGNUP_MODE', group: 'Core', platform: 'both', default: 'open in cloud mode, allowlist otherwise', description: '`closed`, `allowlist` or `open`. Overrides the setting in **Admin → Settings**.' },
  { name: 'APP_SECRET', group: 'Core', platform: 'both', secret: true, default: 'generated on first boot', description: 'Master key, at least 16 characters. Leave unset unless you must move the key: changing it signs everyone out and makes stored credentials unreadable.' },
  { name: 'IMAGES_PUBLIC_URL', group: 'Core', platform: 'both', default: '`APP_URL/img`', description: 'Origin that serves uploaded images, when you put a CDN or a public R2 domain in front of them.' },
  { name: 'SEND_BATCH_SIZE', group: 'Core', platform: 'both', default: '100', description: 'Most emails one send run claims. The platform limit can lower it.' },
  { name: 'TURNSTILE_SITE_KEY', group: 'Core', platform: 'both', description: 'Cloudflare Turnstile site key for signup forms. Needs `TURNSTILE_SECRET_KEY` too.' },
  { name: 'TURNSTILE_SECRET_KEY', group: 'Core', platform: 'both', secret: true, description: 'Cloudflare Turnstile secret key for signup forms.' },
  { name: 'EMAIL_PROVIDER', group: 'Email', platform: 'both', default: 'test', description: '`ses`, `resend`, `smtp` or `test`. `test` keeps every email in a local outbox. `smtp` works on Node only.' },
  { name: 'EMAIL_FROM', group: 'Email', platform: 'both', default: '`mailcorgi@` + the app host', description: 'Sender address for system emails: sign-in codes, invitations, alerts and test emails.' },
  { name: 'EMAIL_FROM_NAME', group: 'Email', platform: 'both', default: 'MailCorgi', description: 'Sender name for system emails.' },
  { name: 'SENDING_ENABLED', group: 'Email', platform: 'both', default: 'true', description: '`false` pauses all outbound email for the install.' },
  { name: 'SEND_RATE_PER_SECOND', group: 'Email', platform: 'both', default: '10', description: 'Install-wide sending rate. Match it to your provider quota.' },
  { name: 'SES_REGION', group: 'Email', platform: 'both', description: 'AWS region of your SES account, for example `eu-west-1`.' },
  { name: 'SES_ACCESS_KEY_ID', group: 'Email', platform: 'both', secret: true, description: 'Access key ID of the IAM user that sends through SES.' },
  { name: 'SES_SECRET_ACCESS_KEY', group: 'Email', platform: 'both', secret: true, description: 'Secret access key of that IAM user.' },
  { name: 'SES_CONFIGURATION_SET', group: 'Email', platform: 'both', description: 'SES configuration set that publishes delivery events to SNS.' },
  { name: 'SES_SNS_TOPIC_ARN', group: 'Email', platform: 'both', description: 'The only SNS topic whose notifications `/hooks/ses` accepts.' },
  { name: 'RESEND_API_KEY', group: 'Email', platform: 'both', secret: true, description: 'Resend API key with sending and domain access.' },
  { name: 'RESEND_WEBHOOK_SECRET', group: 'Email', platform: 'both', secret: true, description: 'Signing secret of the Resend webhook that points at `/hooks/resend`.' },
  { name: 'SMTP_HOST', group: 'Email', platform: 'node', description: 'SMTP server host name.' },
  { name: 'SMTP_PORT', group: 'Email', platform: 'node', description: 'SMTP port, usually 465 (`tls`) or 587 (`starttls`).' },
  { name: 'SMTP_SECURITY', group: 'Email', platform: 'node', description: '`tls`, `starttls` or `none`.' },
  { name: 'SMTP_USER', group: 'Email', platform: 'node', secret: true, description: 'SMTP user name.' },
  { name: 'SMTP_PASSWORD', group: 'Email', platform: 'node', secret: true, description: 'SMTP password.' },
  { name: 'BILLING_PROVIDER', group: 'Billing (cloud mode)', platform: 'both', description: '`stripe` or `polar`.' },
  { name: 'STRIPE_SECRET_KEY', group: 'Billing (cloud mode)', platform: 'both', secret: true, description: 'Stripe secret or restricted key.' },
  { name: 'STRIPE_WEBHOOK_SECRET', group: 'Billing (cloud mode)', platform: 'both', secret: true, description: 'Signing secret of the Stripe webhook that points at `/hooks/stripe`.' },
  { name: 'POLAR_ACCESS_TOKEN', group: 'Billing (cloud mode)', platform: 'both', secret: true, description: 'Polar organization access token.' },
  { name: 'POLAR_WEBHOOK_SECRET', group: 'Billing (cloud mode)', platform: 'both', secret: true, description: 'Secret of the Polar webhook that points at `/hooks/polar`.' },
  { name: 'POLAR_PRODUCTS', group: 'Billing (cloud mode)', platform: 'both', description: 'JSON object from `<plan>_<monthly|yearly>` to Polar product IDs.' },
  { name: 'WEBSITE_CNAME_TARGET', group: 'Websites', platform: 'both', default: 'the `APP_URL` host', description: 'Host name that custom website domains point their CNAME at.' },
  { name: 'CF_API_TOKEN', group: 'Websites', platform: 'cloudflare', secret: true, description: 'Cloudflare API token with SSL and Certificates edit access. With `CF_ZONE_ID`, MailCorgi adds verified website hosts to Cloudflare for SaaS itself.' },
  { name: 'CF_ZONE_ID', group: 'Websites', platform: 'cloudflare', description: 'ID of the zone that holds your Cloudflare for SaaS setup.' },
  { name: 'WORKERS_PLAN', group: 'Platform', platform: 'cloudflare', default: 'free in `wrangler.jsonc`', description: '`free` keeps each run under 40 outbound requests, inside the Workers Free limit of 50. On Workers Paid, delete the line from `wrangler.jsonc` to allow 900 per run.' },
  { name: 'PORT', group: 'Platform', platform: 'node', default: '3000', description: 'HTTP port.' },
  { name: 'TRUST_PROXY', group: 'Platform', platform: 'node', default: 'unset (Caddy\'s fixed address in `docker-compose.yml`)', description: 'Reverse proxies whose `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` count: a comma-separated list of their addresses, or `true` for any loopback or private peer. Unset, MailCorgi uses the socket address and ignores forwarding headers. Set it only when every request reaches MailCorgi through that proxy.' },
  { name: 'HOST', group: 'Platform', platform: 'node', default: '0.0.0.0', description: 'Interface to listen on.' },
  { name: 'DATA_DIR', group: 'Platform', platform: 'node', default: '`./data` (`/data` in Docker)', description: 'Folder for `control.db`, `accounts/*.db`, `images/` and `secret.key`.' },
  { name: 'WEB_DIR', group: 'Platform', platform: 'node', default: '`web/dist`', description: 'Folder with the built web app.' },
  { name: 'NODE_ENV', group: 'Platform', platform: 'node', default: '`production` in Docker', description: '`production` turns off every development-only switch, such as `MC_TEST_DNS`.' },
  { name: 'MC_TEST_DNS', group: 'Platform', platform: 'both', description: 'Development and tests only: a JSON object of canned DNS answers keyed `TYPE:name`, such as `{"TXT:example.com":["v=spf1 mx ~all"]}`. It replaces real lookups, turns on the dev outbox endpoints for install admins, and is ignored when `NODE_ENV` is `production` or the Worker is deployed. Never set it on a real install.' },
]

/** Names the code reads that are internal state, not operator settings. */
export const INTERNAL_ENV = new Map([['SETUP_ORIGIN', 'install_settings row that remembers the first setup origin']])

/** Platform bindings on the Worker `env`. They come from wrangler.jsonc, not from variables. */
const BINDINGS = new Set(['CONTROL', 'ACCOUNT', 'ASSETS', 'IMAGES', 'CF_VERSION_METADATA'])

const root = path.resolve(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (rel !== path.join('server', 'test')) out.push(...sourceFiles(rel))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** Every environment variable name the server and Worker read, found by scanning their source. */
export function readEnvNames(): Set<string> {
  const names = new Set<string>()
  const add = (name: string) => {
    if (!name.startsWith('_') && !BINDINGS.has(name)) names.add(name)
  }
  for (const file of [...sourceFiles('server'), ...sourceFiles('worker')]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) add(m[1])
    for (const m of text.matchAll(/\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) add(m[1])
    for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*[\w.]*\benv\b/g)) for (const n of m[1].split(',')) add(n.trim().split(/[\s:]/)[0])
    // Install settings: every key read through getSetting* can be overridden by its upper-case env var.
    for (const m of text.matchAll(/getSetting(?:Sync)?\(ctx, '([a-z0-9_]+)'\)/g)) add(m[1].toUpperCase())
    for (const m of text.matchAll(/keys: \[([^\]]*)\]/g)) for (const k of m[1].matchAll(/'([a-z0-9_]+)'/g)) add(k[1].toUpperCase())
    for (const m of text.matchAll(/(?:SETTING_KEYS|settingsKeys)\s*=\s*\[([^\]]*)\]/g)) for (const k of m[1].matchAll(/'([a-z0-9_]+)'/g)) add(k[1].toUpperCase())
  }
  return names
}

const START = '<!-- env-reference:start (generated by scripts/env-reference.ts) -->'
const END = '<!-- env-reference:end -->'
const PLATFORM_LABEL: Record<Platform, string> = { both: 'Both', node: 'Node', cloudflare: 'Cloudflare' }
const cell = (s: string) => s.replace(/\|/g, '\\|')

export function renderEnvReference(): string {
  const groups = [...new Set(ENV_VARS.map((v) => v.group))]
  const parts = [START, '']
  for (const group of groups) {
    parts.push(`### ${group}`, '', '| Variable | Platform | Default | Description |', '|---|---|---|---|')
    for (const v of ENV_VARS.filter((x) => x.group === group)) {
      parts.push(`| \`${v.name}\`${v.secret ? ' (secret)' : ''} | ${PLATFORM_LABEL[v.platform]} | ${cell(v.default ?? '')} | ${cell(v.description)} |`)
    }
    parts.push('')
  }
  parts.push(END)
  return parts.join('\n')
}

export const docPath = path.join(root, 'docs', 'self-hosting.md')

export function applyEnvReference(doc: string): string {
  const start = doc.indexOf(START)
  const end = doc.indexOf(END)
  if (start < 0 || end < start) throw new Error(`${path.relative(root, docPath)} has no env reference markers`)
  return doc.slice(0, start) + renderEnvReference() + doc.slice(end + END.length)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const doc = fs.readFileSync(docPath, 'utf8')
  const next = applyEnvReference(doc)
  if (process.argv.includes('--check')) {
    if (next !== doc) {
      console.error('docs/self-hosting.md is stale: run npx tsx scripts/env-reference.ts')
      process.exitCode = 1
    }
  } else if (next !== doc) {
    fs.writeFileSync(docPath, next)
    console.log('docs/self-hosting.md: env reference updated')
  }
}
