import { createContext, useContext, useEffect, useState } from 'react'
import type { SessionAccount, SessionInfo } from '../../../server/control/rpc.ts'
import type { Newsletter } from '../../../server/account/newsletters/index.ts'

export interface Bootstrap {
  setupRequired: boolean
  cloud: boolean
  signupOpen: boolean
  appUrl: string
  session: SessionInfo | null
}

export interface Session {
  boot: Bootstrap
  session: SessionInfo
  account: SessionAccount | null
  newsletters: Newsletter[]
  current: Newsletter | null
  setCurrent(id: string): void
  refresh(): void
  refreshNewsletters(): Promise<unknown>
}

export const SessionContext = createContext<Session | null>(null)
export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside provider')
  return session
}

export const AuthContext = createContext<{ boot: Bootstrap; refresh: () => void }>({ boot: { setupRequired: false, cloud: false, signupOpen: false, appUrl: '', session: null }, refresh: () => {} })
export const useAuth = () => useContext(AuthContext)

export type Role = 'owner' | 'admin' | 'member'
/** The signed-in user's role on a newsletter of the current account, or null without access. */
export function useRole(newsletterId?: string | null): Role | null {
  const session = useContext(SessionContext)
  const account = session?.account
  if (!account) return null
  if (account.owner) return 'owner'
  const id = newsletterId === undefined ? session?.current?.id : newsletterId
  return (id && account.grants[id]) || null
}
/** Owners and newsletter admins can change newsletter settings, import and send. */
export const useCanAdmin = (newsletterId?: string | null) => {
  const role = useRole(newsletterId)
  return role === 'owner' || role === 'admin'
}
export const useIsOwner = () => useRole() === 'owner'

export type Theme = 'light' | 'dark' | 'system'
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('mc-theme') as Theme) || 'system'
    } catch {
      return 'system'
    }
  })
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light'
    }
    apply()
    try {
      localStorage.setItem('mc-theme', theme)
    } catch {}
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme]
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · MailCorgi` : 'MailCorgi'
  }, [title])
}

export const readLocal = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
export const writeLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
