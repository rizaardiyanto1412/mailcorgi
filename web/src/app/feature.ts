import type { RouteObject } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

export interface NavEntry {
  to: string
  label: string
  icon?: LucideIcon
}

/** What a module's `web/src/features/<module>/index.tsx` exports. */
export interface Feature {
  name: string
  /** Routes under the app shell, relative to `/`. */
  routes?: RouteObject[]
  /** Routes under `/settings`, relative to it. */
  settingsRoutes?: RouteObject[]
  /** Sidebar entries. */
  nav?: NavEntry[]
  /** Settings sub-navigation entries. */
  settings?: NavEntry[]
  /** Routes shown to signed-out visitors, relative to `/`. */
  publicRoutes?: RouteObject[]
}
