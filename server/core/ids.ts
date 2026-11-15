/** Ids are `prefix_` + 16 base32 characters. Token formats live here too. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export function randomBase32(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b & 31]
  return out
}

export const newId = (prefix: string) => `${prefix}_${randomBase32(16)}`

export const ID_PREFIX = {
  user: 'usr',
  session: 'ses',
  account: 'acc',
  invite: 'inv',
  alert: 'alr',
  job: 'job',
  newsletter: 'nl',
  author: 'aut',
  contact: 'con',
  field: 'fld',
  tag: 'tag',
  segment: 'seg',
  suppression: 'sup',
  import: 'imp',
  campaign: 'cmp',
  send: 'snd',
  link: 'lnk',
  domain: 'dom',
  apiKey: 'key',
  notification: 'ntf',
  outbox: 'out',
} as const

/** `mc_<accountId>_<secret>`: the edge reads only the account id. */
export function parseApiKey(key: string): { accountId: string; secret: string } | null {
  const match = /^mc_(acc_[a-z2-7]{16})_([A-Za-z0-9_-]{20,})$/.exec(key)
  return match ? { accountId: match[1], secret: match[2] } : null
}
export const formatApiKey = (accountId: string, secret: string) => `mc_${accountId}_${secret}`

/** `nl_<accountId>_<rand>`: the public key of a newsletter. */
export function parseNewsletterKey(key: string): { accountId: string } | null {
  const match = /^nl_(acc_[a-z2-7]{16})_([a-z2-7]{16})$/.exec(key)
  return match ? { accountId: match[1] } : null
}
export const newNewsletterKey = (accountId: string) => `nl_${accountId}_${randomBase32(16)}`

/** Public tokens are `<accountId>.<purpose>.<payload>.<sig>`. The edge reads the account id only. */
export function accountIdOfToken(token: string): string | null {
  const match = /^(acc_[a-z2-7]{16})\./.exec(token)
  return match ? match[1] : null
}

export const isAccountId = (value: string) => /^acc_[a-z2-7]{16}$/.test(value)
