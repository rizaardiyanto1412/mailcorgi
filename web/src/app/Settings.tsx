import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { cx } from '../ui/index.tsx'
import { settingsNav } from './routes.tsx'
import { useRole, useSession } from '../lib/session.tsx'
import type { NavEntry } from './feature.ts'

/** Newsletter pages first, then account-wide pages. Entries not listed keep their feature order at the end. */
const ORDER = ['/settings/newsletter', '/settings/design', '/settings/authors', '/settings/forms', '/settings/contacts', '/settings/hygiene', '/settings/domains', '/settings/team', '/settings/suppressions', '/settings/api', '/settings/account', '/settings/billing']
const rank = (item: NavEntry) => (ORDER.includes(item.to) ? ORDER.indexOf(item.to) : ORDER.length)

export function useSettingsNav(): NavEntry[] {
  const { boot } = useSession()
  const role = useRole()
  const allowed = (item: NavEntry) => !item.role || role === 'owner' || (item.role === 'admin' && role === 'admin')
  const seen = new Set<string>()
  return settingsNav
    .filter((item) => (boot.cloud || item.to !== '/settings/billing') && allowed(item) && !seen.has(item.to) && seen.add(item.to))
    .sort((a, b) => rank(a) - rank(b))
}

export function SettingsLayout() {
  const nav = useSettingsNav()
  const strip = useRef<HTMLUListElement>(null)
  const { pathname } = useLocation()
  // On a phone the tabs scroll sideways; keep the open one in view without moving the page.
  useEffect(() => {
    const list = strip.current
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!list || !active || list.scrollWidth <= list.clientWidth) return
    list.scrollLeft = active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2
  }, [pathname])
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-8">
      <nav className="shrink-0 md:w-44" aria-label="Settings">
        <p className="mb-2 hidden px-2.5 text-xs font-medium text-fg-3 md:block">Settings</p>
        <ul ref={strip} className="relative -mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
          {nav.map((item) => (
            <li key={item.to} className="shrink-0">
              <NavLink to={item.to} className={({ isActive }) => cx('block rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors', isActive ? 'bg-surface text-accent-fg shadow-card' : 'text-fg-2 hover:bg-hover hover:text-fg')}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
