import type { Limits } from '../../account/rpc.ts'

export const planNames = ['free', 'starter', 'growth', 'pro', 'scale'] as const
export type PlanName = typeof planNames[number]
export type Interval = 'monthly' | 'yearly'
const plan = (name: PlanName, maxContacts: number, maxEmailsPerMonth: number, maxNewsletters: number, maxTeamPerNewsletter: number, monthly: number, yearly: number) => ({
  name, maxContacts, maxEmailsPerMonth, maxNewsletters, maxTeamPerNewsletter, monthly, yearly,
  lookupKeys: { monthly: `mailcorgi_${name}_monthly`, yearly: `mailcorgi_${name}_yearly` },
})
export const plans = {
  free: plan('free', 1000, 10_000, 1, 2, 0, 0),
  starter: plan('starter', 5000, 50_000, 3, 5, 1900, 19000),
  growth: plan('growth', 15000, 150_000, 5, 10, 4900, 49000),
  pro: plan('pro', 50000, 500_000, 10, 20, 9900, 99000),
  scale: plan('scale', 150000, 1_500_000, 25, 50, 24900, 249000),
} satisfies Record<PlanName, Limits & { name: PlanName; monthly: number; yearly: number; lookupKeys: Record<Interval, string> }>
export const unlimited: Limits = { maxContacts: null, maxEmailsPerMonth: null, maxNewsletters: null, maxTeamPerNewsletter: null }
export const isPlan = (name: string): name is PlanName => planNames.some((p) => p === name)
export function planLimits(name: string, cloud = true): Limits {
  if (!cloud) return unlimited
  const p = plans[isPlan(name) ? name : 'free']
  return { maxContacts: p.maxContacts, maxEmailsPerMonth: p.maxEmailsPerMonth, maxNewsletters: p.maxNewsletters, maxTeamPerNewsletter: p.maxTeamPerNewsletter }
}
