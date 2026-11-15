import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Bell, Check, ChevronsUpDown, LogOut, Menu as MenuIcon, Monitor, Moon, Plus, Settings, ShieldCheck, Sun, X } from 'lucide-react'
import { writeLocal } from '../lib/session.tsx'
import { api, useActionQuery } from '../lib/api.ts'
import { useSession, useTheme, type Theme } from '../lib/session.tsx'
import { Avatar, Banner, cx, IconButton, Logo, MenuDivider, MenuItem, MenuLabel, Popover } from '../ui/index.tsx'
import { mainNav } from './routes.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { NotificationsBell } from '../features/notifications/index.tsx'

const navItem = (active: boolean) =>
  cx('flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors [&>svg]:size-4 [&>svg]:shrink-0', active ? 'bg-surface text-accent-fg shadow-card' : 'text-fg-2 hover:bg-hover hover:text-fg [&>svg]:text-fg-3')

function NewsletterSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { current, setCurrent, account } = useSession()
  const groups = useActionQuery('team.newsletters', {}, { staleTime: 30_000 })
  const [switchError, setSwitchError] = useState('')
  const select = async (accountId: string, newsletterId: string) => {
    try {
      if (accountId === account?.id) setCurrent(newsletterId)
      else {
        await api.post('/auth/account', { accountId })
        writeLocal(`mc-current:${accountId}`, newsletterId)
        window.location.assign('/')
      }
    } catch (err) { setSwitchError(err instanceof Error ? err.message : 'Could not switch newsletters.') }
  }
  const navigate = useNavigate()
  return (
    <Popover
      width={248}
      trigger={({ ref, ...props }) => (
        <button ref={ref} type="button" {...props} className="flex h-10 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-left shadow-card transition-colors hover:bg-sunken">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-xs font-semibold text-accent-fg">{(current?.name ?? '?')[0]?.toUpperCase()}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{current?.name ?? 'Pick a newsletter'}</span>
          <ChevronsUpDown className="size-3.5 text-fg-3" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <>
          {(switchError || groups.error) && <p role="alert" className="px-2 text-xs text-danger">{switchError || groups.error?.message}</p>}
          {groups.isPending && <MenuLabel>Loading newsletters…</MenuLabel>}
          {groups.data?.accounts.map((a) => <div key={a.id}>
            <MenuLabel>{a.name}{!a.owner && ' · Shared with you'}</MenuLabel>
            {!a.newsletters.length && <MenuLabel>No newsletters yet</MenuLabel>}
            {a.newsletters.map((n) => <MenuItem key={n.id} checked={a.id === account?.id && n.id === current?.id} onSelect={() => { void select(a.id, n.id); close(); onNavigate?.() }}>{n.name}</MenuItem>)}
          </div>)}
          <MenuDivider />
          {account?.owner && <MenuItem
            icon={<Plus />}
            onSelect={() => {
              close()
              onNavigate?.()
              navigate('/welcome')
            }}
          >
            New newsletter
          </MenuItem>}
          <MenuItem
            icon={<Settings />}
            onSelect={() => {
              close()
              onNavigate?.()
              navigate('/settings/newsletter')
            }}
          >
            Newsletter settings
          </MenuItem>
        </>
      )}
    </Popover>
  )
}

function AccountMenu() {
  const { session, account, refresh } = useSession()
  const navigate = useNavigate()
  const [theme, setTheme] = useTheme()
  const themes: { id: Theme; label: string; icon: ReactNode }[] = [
    { id: 'light', label: 'Light', icon: <Sun /> },
    { id: 'dark', label: 'Dark', icon: <Moon /> },
    { id: 'system', label: 'Match system', icon: <Monitor /> },
  ]
  const signOut = async () => {
    await api.post('/auth/signout')
    refresh()
  }
  const switchAccount = async (accountId: string) => {
    await api.post('/auth/account', { accountId })
    window.location.assign('/')
  }
  return (
    <Popover
      align="start"
      side="top"
      width={240}
      trigger={({ ref, ...props }) => (
        <button ref={ref} type="button" {...props} aria-label="Account menu" className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-hover">
          <Avatar name={session.user.name || session.user.email} size={26} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{session.user.name || session.user.email}</span>
            <span className="block truncate text-xs text-fg-3">{account?.name ?? session.user.email}</span>
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-2.5 pt-1.5 pb-2">
            <p className="truncate text-[13px] font-medium">{session.user.name}</p>
            <p className="truncate text-xs text-fg-3">{session.user.email}</p>
          </div>
          {session.accounts.length > 1 && (
            <>
              <MenuDivider />
              <MenuLabel>Accounts</MenuLabel>
              {session.accounts.map((a) => (
                <MenuItem key={a.id} checked={a.id === account?.id} icon={a.id === account?.id ? <Check /> : undefined} onSelect={() => void switchAccount(a.id)}>
                  {a.name}
                </MenuItem>
              ))}
            </>
          )}
          <MenuDivider />
          <MenuLabel>Theme</MenuLabel>
          {themes.map((t) => (
            <MenuItem key={t.id} icon={t.icon} checked={theme === t.id} onSelect={() => setTheme(t.id)}>
              {t.label}
            </MenuItem>
          ))}
          <MenuDivider />
          {session.user.isInstallAdmin && (
            <MenuItem
              icon={<ShieldCheck />}
              onSelect={() => {
                close()
                navigate('/admin')
              }}
            >
              Admin console
            </MenuItem>
          )}
          <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
            Sign out
          </MenuItem>
        </>
      )}
    </Popover>
  )
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full w-[232px] flex-col gap-3 bg-canvas p-3">
      <NavLink to="/" onClick={onNavigate} aria-label="MailCorgi home" className="flex h-8 items-center gap-2 rounded-md px-1.5">
        <Logo size={22} />
        <span className="text-[15px] font-semibold tracking-tight">MailCorgi</span>
        <span className="flex-1" />
        <NotificationsBell />
      </NavLink>
      <NewsletterSwitcher onNavigate={onNavigate} />
      <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Main">
        <ul className="flex flex-col gap-px">
          {mainNav.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.to === '/'} onClick={onNavigate} className={({ isActive }) => navItem(isActive)}>
                {item.icon ? <item.icon aria-hidden /> : <Bell className="opacity-0" aria-hidden />}
                <span className="flex-1">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <ul className="mt-3 flex flex-col gap-px border-t border-line pt-3">
          <li>
            <NavLink to="/settings" onClick={onNavigate} className={({ isActive }) => navItem(isActive)}>
              <Settings aria-hidden />
              <span className="flex-1">Settings</span>
            </NavLink>
          </li>
        </ul>
      </nav>
      <AccountMenu />
    </div>
  )
}

export function Shell() {
  const [planLimit, setPlanLimit] = useState(false)
  const { boot } = useSession()
  useEffect(() => {
    const show = () => setPlanLimit(true)
    window.addEventListener('mc:plan-limit', show)
    return () => window.removeEventListener('mc:plan-limit', show)
  }, [])
  const [drawer, setDrawer] = useState(false)
  return (
    <div className="flex h-full">
      <aside className="hidden shrink-0 border-r border-line md:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="animate-fade fixed inset-0 z-30 bg-black/40 md:hidden" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <div className="animate-pop h-full w-[232px] border-r border-line shadow-pop">
            <Sidebar onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden">
          <IconButton label={drawer ? 'Close menu' : 'Open menu'} onClick={() => setDrawer((d) => !d)}>
            {drawer ? <X /> : <MenuIcon />}
          </IconButton>
          <Logo size={20} />
          <span className="text-[14px] font-semibold">MailCorgi</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          {boot.cloud && planLimit && <div className="px-5 pt-4"><Banner kind="warn" action={<button type="button" onClick={() => setPlanLimit(false)} aria-label="Dismiss plan limit">×</button>}>Your account has reached a plan limit. <Link className="underline" to="/settings/billing">View plans and usage</Link></Banner></div>}
          <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  )
}
