import { z } from 'zod'
import domains from './lists/disposable-domains.json' with { type: 'json' }

const disposable = new Set(domains)
const roles = new Set(['admin', 'administrator', 'abuse', 'billing', 'contact', 'customerservice', 'hello', 'help', 'hostmaster', 'info', 'jobs', 'marketing', 'noreply', 'no-reply', 'office', 'postmaster', 'sales', 'security', 'support', 'team', 'webmaster'])
const typos: Record<string, string> = { 'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'hotmial.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'icloud.con': 'icloud.com' }
export function classifyDomain(domain: string): { reason: string | null; suggestion: string } {
  if (typos[domain]) return { reason: 'domain_typo', suggestion: typos[domain] }
  const parts = domain.split('.')
  if (parts.some((_, i) => disposable.has(parts.slice(i).join('.')))) return { reason: 'disposable_domain', suggestion: '' }
  return { reason: null, suggestion: '' }
}
export function cleanEmail(raw: string): { email: string; domain: string; reason: string | null; suggestion: string } {
  const email = raw.trim().toLowerCase()
  const [local = '', domain = ''] = email.split('@')
  const invalid = !z.email().safeParse(email).success || email.length > 254 || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
  if (invalid) return { email, domain, reason: 'invalid_syntax', suggestion: '' }
  const issue = classifyDomain(domain)
  if (issue.reason === 'domain_typo') return { email, domain, reason: issue.reason, suggestion: local + '@' + issue.suggestion }
  if (roles.has(local.split('+')[0])) return { email, domain, reason: 'role_address', suggestion: '' }
  if (issue.reason) return { email, domain, reason: issue.reason, suggestion: '' }
  return { email, domain, reason: null, suggestion: '' }
}
