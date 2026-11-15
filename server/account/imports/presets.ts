import type { Mapping } from './model.ts'

export const presetNames = ['generic', 'beehiiv', 'Substack', 'Mailchimp', 'Kit', 'MailerLite', 'Buttondown', 'Ghost', 'EmailOctopus', 'listmonk'] as const
export type Preset = typeof presetNames[number]
export const normalizeHeader = (s: string) => s.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '')
const aliases = {
  email: ['email', 'emailaddress', 'subscriberemail'],
  name: ['name', 'fullname'], firstName: ['firstname', 'fname'], lastName: ['lastname', 'lname'],
  status: ['subscribertype', 'status', 'subscriptionstatus', 'subscriberstatus', 'emailstatus', 'issubscribed', 'receivesemails', 'subscribed', 'subscribedtoemails', 'emaildisabled'],
  signupDate: ['subscribedat', 'subscriptiondate', 'createdat', 'creationdate', 'created', 'signupdate', 'subscribedat', 'subscriptiondate', 'subscribedon', 'optintime', 'timestamp', 'datecreated', 'addedon'],
  unsubscribeDate: ['unsubscribedat', 'unsubscriptiondate', 'unsubscribetime', 'unsubtime'],
  tags: ['tags', 'labels', 'groups'],
} satisfies Record<string, string[]>

export function suggestMapping(headers: string[]): Mapping {
  const find = (choices: string[]) => choices.map((alias) => headers.find((h) => normalizeHeader(h) === alias)).find((header) => header !== undefined)
  return { email: find(aliases.email) ?? '', name: find(aliases.name), firstName: find(aliases.firstName), lastName: find(aliases.lastName), status: find(aliases.status), signupDate: find(aliases.signupDate), unsubscribeDate: find(aliases.unsubscribeDate), tags: find(aliases.tags), fields: {} }
}
export function detectPreset(headers: string[]): Preset {
  const h = new Set(headers.map(normalizeHeader))
  if (h.has('optintime') || h.has('leid') || h.has('euid')) return 'Mailchimp'
  if (h.has('uuid') && (h.has('subscribedtoemails') || h.has('complimentaryplan'))) return 'Ghost'
  if (h.has('subscriptiontier') || h.has('utmchannel') || h.has('referralcount')) return 'beehiiv'
  if (h.has('subscriptiontype') || h.has('receivesemails') || h.has('subscriptionplan')) return 'Substack'
  if (h.has('unsubscribedat') || h.has('subscriberid') && h.has('emailaddress')) return 'Kit'
  if (h.has('sent') && h.has('opened') || h.has('datecreated')) return 'MailerLite'
  if (h.has('emaildisabled') || h.has('subscribertype')) return 'Buttondown'
  if (h.has('emailoctopusid') || h.has('addedon')) return 'EmailOctopus'
  if (h.has('attribs') || h.has('lists') && h.has('uuid')) return 'listmonk'
  return 'generic'
}

export type MappedStatus = 'subscribed' | 'pending' | 'unsubscribed' | 'cleaned' | 'bounced' | 'complained' | 'unknown'
export function mapStatus(value: string, header = ''): MappedStatus {
  const v = value.trim().toLowerCase().replace(/[ _-]/g, '')
  if (normalizeHeader(header) === 'emaildisabled') return ['true', '1', 'yes'].includes(v) ? 'unsubscribed' : ['false', '0', 'no'].includes(v) ? 'subscribed' : 'unknown'
  if (['subscribed', 'active', 'enabled', 'confirmed', 'normal', 'valid', 'true', '1', 'yes', 'regular'].includes(v)) return 'subscribed'
  if (['unsubscribed', 'unsubscribe', 'inactive', 'disabled', 'unsub', 'false', '0', 'no', 'blocked', 'blocklisted'].includes(v)) return 'unsubscribed'
  if (['pending', 'unconfirmed', 'nonsubscribed', 'unactivated', 'unverified'].includes(v)) return 'pending'
  if (['cleaned', 'deleted', 'archived', 'invalid'].includes(v)) return 'cleaned'
  if (['bounced', 'hardbounce', 'bouncing'].includes(v)) return 'bounced'
  if (['complained', 'spam', 'complaint'].includes(v)) return 'complained'
  return 'unknown'
}

export function parseSignupDate(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  if (/^\d{10}(\d{3})?$/.test(text)) return Number(text) * (text.length === 10 ? 1000 : 1)
  if (!/^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?$/.test(text)) return NaN
  const day = text.slice(0, 10)
  const at = Date.parse(text.length === 10 ? text + 'T00:00:00Z' : text.replace(' ', 'T') + (/(Z|[+-]\d\d:?\d\d)$/.test(text) ? '' : 'Z'))
  if (!Number.isFinite(at) || new Date(Date.parse(day + 'T00:00:00Z')).toISOString().slice(0, 10) !== day) return NaN
  return at
}
