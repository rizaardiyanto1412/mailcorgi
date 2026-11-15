import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useRoutes, type RouteObject } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, setCsrf, useActionQuery } from '../lib/api.ts'
import { AuthContext, readLocal, SessionContext, writeLocal, type Bootstrap, type Session } from '../lib/session.tsx'
import { Spinner } from '../ui/index.tsx'
import { Shell } from './Shell.tsx'
import { SettingsLayout } from './Settings.tsx'
import { Welcome } from './Welcome.tsx'
import { appRoutes, publicRoutes, settingsNav, settingsRoutes } from './routes.tsx'
import { SetupPage } from '../features/auth/index.tsx'

const Splash = () => (
  <div className="flex h-full items-center justify-center">
    <Spinner className="size-5" />
  </div>
)

export function App() {
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api.get<Bootstrap>('/auth/bootstrap'), staleTime: Infinity, refetchOnWindowFocus: false })
  useEffect(() => {
    const onSignedOut = () => void boot.refetch()
    window.addEventListener('mc:signed-out', onSignedOut)
    return () => window.removeEventListener('mc:signed-out', onSignedOut)
  }, [boot])
  setCsrf(boot.data?.session?.csrf ?? '')
  const auth = useMemo(() => ({ boot: boot.data!, refresh: () => void boot.refetch() }), [boot])
  const publicTree = useRoutes([...publicRoutes, { path: '*', element: <Navigate to="/signin" replace /> }])
  const setupTree = useRoutes([{ path: '*', element: <SetupPage /> }])

  if (boot.isPending) return <Splash />
  if (boot.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-fg-2">MailCorgi could not reach its server.</p>
        <button type="button" className="text-sm font-medium text-accent-fg underline" onClick={() => void boot.refetch()}>
          Try again
        </button>
      </div>
    )
  }
  if (boot.data.setupRequired) return <AuthContext.Provider value={auth}>{setupTree}</AuthContext.Provider>
  if (!boot.data.session) return <AuthContext.Provider value={auth}>{publicTree}</AuthContext.Provider>
  return (
    <AuthContext.Provider value={auth}>
      <Authed boot={boot.data} refresh={auth.refresh} />
    </AuthContext.Provider>
  )
}

function Authed({ boot, refresh }: { boot: Bootstrap; refresh: () => void }) {
  const location = useLocation()
  const session = boot.session!
  const account = session.accounts.find((a) => a.id === session.current) ?? null
  const newsletters = useActionQuery('newsletters.list', {}, { enabled: !!account, staleTime: 30_000 })
  const storageKey = `mc-current:${session.current ?? 'none'}`
  const [currentId, setCurrentId] = useState(() => readLocal(storageKey))
  const list = useMemo(() => newsletters.data?.newsletters ?? [], [newsletters.data])
  const current = list.find((n) => n.id === currentId) ?? list[0] ?? null

  const value = useMemo<Session>(
    () => ({
      boot,
      session,
      account,
      newsletters: list,
      current,
      setCurrent: (id) => {
        writeLocal(storageKey, id)
        setCurrentId(id)
      },
      refresh,
      refreshNewsletters: () => newsletters.refetch(),
    }),
    [boot, session, account, list, current, storageKey, refresh, newsletters],
  )

  const tree: RouteObject[] = [
    { path: '/welcome', element: <Welcome /> },
    list.length === 0 && account && !['/admin', '/settings/account', '/settings/billing'].some((path) => location.pathname === path || location.pathname.startsWith(path + '/'))
      ? { path: '*', element: <Navigate to="/welcome" replace /> }
      : {
          element: <Shell />,
          children: [
            ...appRoutes,
            {
              path: 'settings',
              element: <SettingsLayout />,
              children: [{ index: true, element: <Navigate to={settingsNav[0]?.to ?? '/'} replace /> }, ...settingsRoutes],
            },
            { path: '*', element: <Navigate to="/" replace /> },
          ],
        },
  ]
  const element = useRoutes(tree)
  if (account && newsletters.isPending) return <Splash />
  return <SessionContext.Provider value={value}>{element}</SessionContext.Provider>
}
