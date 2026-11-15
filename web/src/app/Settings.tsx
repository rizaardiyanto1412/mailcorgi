import { NavLink, Outlet } from 'react-router-dom'
import { cx, PageHeader } from '../ui/index.tsx'
import { settingsNav } from './routes.tsx'
import { useSession } from '../lib/session.tsx'

export function SettingsLayout() {
  const { current } = useSession()
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description={current ? `${current.name} and your account` : undefined} />
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="shrink-0 md:w-48" aria-label="Settings">
          <ul className="flex flex-row flex-wrap gap-1 md:flex-col">
            {settingsNav.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} className={({ isActive }) => cx('block rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors', isActive ? 'bg-surface text-accent-fg shadow-card' : 'text-fg-2 hover:bg-hover hover:text-fg')}>
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
    </div>
  )
}
