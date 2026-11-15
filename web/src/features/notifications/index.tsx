import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, PageHeader, Popover, Skeleton } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

function NotificationList() {
  const query = useActionQuery('notifications.list', {})
  const mark = useAction('notifications.markRead', { invalidate: ['notifications.list'] })
  return <div className="max-h-96 overflow-y-auto">
    {(query.error || mark.error) && <Banner kind="danger">{query.error?.message || mark.error?.message}</Banner>}
    {query.isPending && <Skeleton className="m-3 h-16" />}
    {query.data?.items.length ? <ul>{query.data.items.map((n) => <li key={n.id} className="border-b border-line p-3 last:border-0"><Link to={n.href.startsWith('/') && !n.href.startsWith('//') ? n.href : '/'} onClick={() => { if (!n.read_at) mark.mutate({ ids: [n.id] }) }} className="block"><p className={`text-sm ${n.read_at ? 'text-fg-2' : 'font-medium text-fg'}`}>{!n.read_at && <span aria-label="Unread" className="mr-1 text-accent-fg">●</span>}{n.title}</p><p className="mt-1 text-xs text-fg-3">{n.body}</p><time className="mt-1 block text-xs text-fg-3" dateTime={new Date(n.created_at).toISOString()}>{new Date(n.created_at).toLocaleString()}</time></Link></li>)}</ul> : query.data && <EmptyState title="You’re all caught up" body="Campaign results, imports and account updates appear here." />}
    {!!query.data?.items.some((n) => n.read_at === null) && <div className="p-3"><Button loading={mark.isPending} onClick={() => mark.mutate({ ids: query.data?.items.filter((n) => n.read_at === null).map((n) => n.id) ?? [] })}>Mark visible as read</Button></div>}
  </div>
}

export function NotificationsBell() {
  const query = useActionQuery('notifications.list', {}, { refetchInterval: 30_000 })
  const mark = useAction('notifications.markRead', { invalidate: ['notifications.list'] })
  const unread = query.data?.unread ?? 0
  return <Popover align="end" width={320} role="dialog" trigger={(props) => <button {...props} type="button" onClick={() => { props.onClick(); if (!props['aria-expanded']) { const ids = query.data?.items.filter((n) => n.read_at === null).map((n) => n.id) ?? []; if (ids.length) mark.mutate({ ids }) } }} className="relative flex size-7 items-center justify-center rounded-md text-fg-2 hover:bg-hover" title="Notifications" aria-label={`Notifications, ${unread} unread`} aria-expanded={props['aria-expanded']}><Bell className="size-4" aria-hidden />{unread > 0 && <span className="absolute -top-1 -right-1 rounded-full bg-accent px-1 text-[10px] text-on-accent">{unread > 99 ? '99+' : unread}</span>}</button>}>{() => <><div className="border-b border-line p-3 text-sm font-medium">Notifications</div>{mark.error && <Banner kind="danger">{mark.error.message}</Banner>}<NotificationList /><Link to="/notifications" className="block p-3 text-center text-xs text-accent-fg underline">View notifications</Link></>}</Popover>
}

function NotificationsPage() {
  useDocumentTitle('Notifications')
  const [cursor, setCursor] = useState<{ before: number; beforeId: string } | undefined>()
  const query = useActionQuery('notifications.list', cursor ?? {})
  const mark = useAction('notifications.markRead', { invalidate: ['notifications.list'] })
  return <div className="flex flex-col gap-6"><PageHeader title="Notifications" description="Your campaign, import and account updates." />{(query.error || mark.error) && <Banner kind="danger">{query.error?.message || mark.error?.message}</Banner>}<Card>{query.isPending ? <Skeleton className="h-32" /> : query.data?.items.length ? <ul>{query.data.items.map((n) => <li className="border-b border-line p-4 last:border-0" key={n.id}><Link className="text-sm text-accent-fg underline" to={n.href} onClick={() => mark.mutate({ ids: [n.id] })}>{n.title}</Link><p className="mt-1 text-sm text-fg-3">{n.body}</p><p className="mt-1 text-xs text-fg-3">{new Date(n.created_at).toLocaleString()} · {n.read_at === null ? 'Unread' : 'Read'}</p></li>)}</ul> : <EmptyState title="No notifications here" body="Campaign results and account updates appear here as you use MailCorgi." />}</Card><div className="flex gap-2">{cursor !== undefined && <Button onClick={() => setCursor(undefined)}>Newest</Button>}{query.data?.items.length === 50 && <Button onClick={() => { const last = query.data?.items.at(-1); if (last) setCursor({ before: last.created_at, beforeId: last.id }) }}>Older</Button>}</div></div>
}
export const notificationsFeature: Feature = { name: 'notifications', routes: [{ path: 'notifications', element: <NotificationsPage /> }] }
