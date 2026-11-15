import type { Feature } from './feature.ts'
import { authFeature } from '../features/auth/index.tsx'
import { statsFeature } from '../features/stats/index.tsx'
import { campaignsFeature } from '../features/campaigns/index.tsx'
import { contactsFeature } from '../features/contacts/index.tsx'
import { segmentsFeature } from '../features/segments/index.tsx'
import { importsFeature } from '../features/imports/index.tsx'
import { websiteFeature } from '../features/website/index.tsx'
import { newslettersFeature } from '../features/newsletters/index.tsx'
import { signupFeature } from '../features/signup/index.tsx'
import { domainsFeature } from '../features/domains/index.tsx'
import { teamFeature } from '../features/team/index.tsx'
import { apikeysFeature } from '../features/apikeys/index.tsx'
import { accountsFeature } from '../features/accounts/index.tsx'
import { billingFeature } from '../features/billing/index.tsx'
import { adminFeature } from '../features/admin/index.tsx'
import { docsFeature } from '../features/docs/index.tsx'
import { notificationsFeature } from '../features/notifications/index.tsx'
import { designFeature } from '../features/design/index.tsx'
import { renderFeature } from '../features/render/index.tsx'
import { sendingFeature } from '../features/sending/index.tsx'
import { trackingFeature } from '../features/tracking/index.tsx'
import { hygieneFeature } from '../features/hygiene/index.tsx'
import { usageFeature } from '../features/usage/index.tsx'
import { directoryFeature } from '../features/directory/index.tsx'
import { installFeature } from '../features/install/index.tsx'
import { suppressionFeature } from '../features/suppression/index.tsx'

/** Every feature, in sidebar order. A module adds itself here and nowhere else. */
export const features: Feature[] = [
  authFeature,
  statsFeature,
  campaignsFeature,
  contactsFeature,
  segmentsFeature,
  importsFeature,
  websiteFeature,
  newslettersFeature,
  signupFeature,
  domainsFeature,
  teamFeature,
  apikeysFeature,
  accountsFeature,
  billingFeature,
  adminFeature,
  docsFeature,
  notificationsFeature,
  renderFeature,
  designFeature,
  sendingFeature,
  trackingFeature,
  hygieneFeature,
  usageFeature,
  directoryFeature,
  installFeature,
  suppressionFeature,
]

export const mainNav = features.flatMap((f) => f.nav ?? [])
export const settingsNav = features.flatMap((f) => f.settings ?? [])
export const appRoutes = features.flatMap((f) => f.routes ?? [])
export const settingsRoutes = features.flatMap((f) => f.settingsRoutes ?? [])
export const publicRoutes = features.flatMap((f) => f.publicRoutes ?? [])
