import { useState, type FormEvent } from 'react'
import { useSession } from '../../lib/session.tsx'
import { callAction, useActionQuery } from '../../lib/api.ts'
import { Badge, Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

function TeamPage() {
  const { current, account, session } = useSession()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const input = { accountId: account?.id ?? '', newsletterId: current?.id ?? '' }
  const team = useActionQuery('team.list', input, { enabled: !!current && !!account?.owner })
  const run = async (action: () => Promise<unknown>, message = '') => {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await action()
      setNotice(message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the team.')
    } finally {
      if (account?.owner) await team.refetch()
      setBusy(false)
    }
  }
  if (!current || !account) return <EmptyState title="Choose a newsletter" body="Choose a newsletter in the switcher to manage its team." />
  const yourRole = account.owner ? 'owner' : account.grants[current.id]
  const invite = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => { await callAction('team.invite', { ...input, email, role }); setEmail('') }, 'Invitation emailed. The link is valid for 7 days.')
  }
  return <div className="flex flex-col gap-5">
    <PageHeader title="Team" description={`People who work on ${current.name}`} />
    {error && <Banner kind="danger">{error}</Banner>}
    {notice && <Banner kind="ok">{notice}</Banner>}
    <div className="flex flex-wrap items-center gap-2"><Badge>{yourRole}</Badge>{!account.owner && <Badge tone="accent">Shared with you</Badge>}<span className="text-sm text-fg-3">{session.user.email}</span></div>
    {!account.owner ? <Card><p className="mb-4 text-sm text-fg-2">Only the owner can invite people or change roles. Members write drafts and see stats. Admins also send, import and change settings.</p><Button variant="danger" disabled={busy} onClick={() => { if (window.confirm('Leave this newsletter? The owner will need to invite you again.')) void run(async () => { await callAction('team.leave', input); window.location.assign('/') }) }}>Leave newsletter</Button></Card> : <>
      <Card><form onSubmit={invite} className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">Members write drafts and see stats. Admins also send, import and change settings. Pending invitations reserve a team seat.</p>
        <Field label="Email">{(id) => <Input id={id} type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Role">{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></Select>}</Field>
        <div><Button type="submit" variant="primary" loading={busy}>Send invitation</Button></div>
      </form></Card>
      {team.isPending ? <Spinner /> : team.error ? <Banner kind="danger">{team.error.message}</Banner> : <>
        <h2 className="text-sm font-semibold">Members</h2>
        {!team.data?.members.length ? <EmptyState title="No team members yet" body="Send an invitation above to share this newsletter." /> : team.data.members.map((m) => <Card key={m.userId}><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{m.name}</p><p className="break-all text-xs text-fg-3">{m.email}</p></div><Badge>{m.role}</Badge><Select aria-label={`Role for ${m.email}`} value={m.role} disabled={busy} onChange={(e) => void run(() => callAction('team.changeRole', { ...input, userId: m.userId, role: e.target.value === 'admin' ? 'admin' : 'member' }))}><option value="member">Member</option><option value="admin">Admin</option></Select><Button variant="danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.email} from this newsletter?`)) void run(() => callAction('team.remove', { ...input, userId: m.userId })) }}>Remove</Button></div></Card>)}
        <h2 className="text-sm font-semibold">Pending invitations</h2>
        {!team.data?.invites.length ? <EmptyState title="No pending invitations" body="New invitations will appear here until accepted or expired." /> : team.data.invites.map((i) => <Card key={i.id}><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="break-all text-sm">{i.email}</p><p className="text-xs text-fg-3">Expires {new Date(i.expiresAt).toLocaleDateString()}</p></div><Badge>{i.role}</Badge><Button disabled={busy} onClick={() => void run(() => callAction('team.resend', { ...input, inviteId: i.id }), 'Invitation emailed. The previous link no longer works.')}>Resend</Button><Button variant="danger" disabled={busy} onClick={() => void run(() => callAction('team.revoke', { ...input, inviteId: i.id }))}>Revoke</Button></div></Card>)}
      </>}
    </>}
  </div>
}

export const teamFeature: Feature = {
  name: 'team',
  settings: [{ to: '/settings/team', label: 'Team' }],
  settingsRoutes: [{ path: 'team', element: <TeamPage /> }],
}
