import { useState, type FormEvent } from 'react'
import { useSession } from '../../lib/session.tsx'
import { callAction, useActionQuery } from '../../lib/api.ts'
import { Badge, Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, useFeedback } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

function TeamPage() {
  const { current, account, session } = useSession()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [shared, setShared] = useState<{ email: string; link: string; emailed: boolean } | null>(null)
  const feedback = useFeedback()
  const input = { accountId: account?.id ?? '', newsletterId: current?.id ?? '' }
  const team = useActionQuery('team.list', input, { enabled: !!current && !!account?.owner })
  const run = async (action: () => Promise<unknown>, message = '') => {
    setError('')
    setNotice('')
    setShared(null)
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
    void run(async () => { const sent = await callAction('team.invite', { ...input, email, role }); setEmail(''); setShared({ email: sent.email, link: sent.link, emailed: sent.emailed }) })
  }
  const resend = (inviteId: string) => run(async () => { const sent = await callAction('team.resend', { ...input, inviteId }); setShared({ email: sent.email, link: sent.link, emailed: sent.emailed }) })
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); feedback.toast('Link copied') } catch { feedback.toast('Could not copy. Select the link and copy it.', { kind: 'error' }) }
  }
  const emailConfigured = team.data?.emailConfigured ?? true
  const ask = (title: string, body: string, confirmLabel: string) => feedback.confirm({ title, body, confirmLabel, danger: true })
  return <div className="flex flex-col gap-5">
    <PageHeader title="Team" description={`People who work on ${current.name}.`} />
    {error && <Banner kind="danger">{error}</Banner>}
    {notice && <Banner kind="ok">{notice}</Banner>}
    {account.owner && !emailConfigured && <Banner kind="warn">No email provider is set up, so invitations are not emailed. Copy the link after you invite someone and send it to them yourself.</Banner>}
    {shared && <Card className="flex flex-col gap-3 p-4 sm:p-5">
      <h2 className="font-semibold">{shared.emailed && emailConfigured ? `Invitation emailed to ${shared.email}` : `Send this link to ${shared.email}`}</h2>
      <p className="text-sm text-fg-3">{shared.emailed ? '' : 'The email could not be sent. '}Anyone with this link can join as the invited address, so share it only with them. It works for 7 days and is shown only now.</p>
      <div className="flex flex-col gap-2 sm:flex-row"><Input aria-label="Invitation link" readOnly value={shared.link} onFocus={(e) => e.target.select()} className="font-mono text-xs" /><Button variant="primary" onClick={() => void copy(shared.link)}>Copy link</Button></div>
    </Card>}
    <div className="flex flex-wrap items-center gap-2 text-sm text-fg-3">You are signed in as {session.user.email}<StatusBadge status={yourRole ?? 'member'} />{!account.owner && <Badge tone="accent">Shared with you</Badge>}</div>
    {!account.owner ? <Card className="flex flex-col items-start gap-4 p-4 sm:p-5"><p className="text-sm text-fg-2">Only the owner can invite people or change roles. Members write drafts and see stats. Admins also send, import and change settings.</p><Button variant="danger" disabled={busy} onClick={async () => { if (await ask('Leave this newsletter?', 'The owner will need to invite you again.', 'Leave newsletter')) void run(async () => { await callAction('team.leave', input); window.location.assign('/') }) }}>Leave newsletter</Button></Card> : <>
      <Card className="p-4 sm:p-5"><form onSubmit={invite} className="flex flex-col gap-4">
        <h2 className="font-semibold">Invite someone</h2>
        <p className="text-sm text-fg-3">Members write drafts and see stats. Admins also send, import and change settings. Pending invitations reserve a team seat.</p>
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label="Email">{(id) => <Input id={id} type="email" required maxLength={254} placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Role">{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></Select>}</Field>
        </div>
        <div><Button type="submit" variant="primary" loading={busy}>{emailConfigured ? 'Send invitation' : 'Create invitation'}</Button></div>
      </form></Card>
      {team.isPending ? <Spinner /> : team.error ? <Banner kind="danger">{team.error.message}</Banner> : <>
        <h2 className="font-semibold">Members</h2>
        {!team.data?.members.length ? <Card><EmptyState title="No team members yet" body="Send an invitation above to share this newsletter." /></Card> : <Table head={<tr><th>Person</th><th className="w-40">Role</th><th className="w-24"><span className="sr-only">Actions</span></th></tr>}>{team.data.members.map((m) => <tr key={m.userId}>
          <td><p className="font-medium">{m.name}</p><p className="break-all text-xs text-fg-3">{m.email}</p></td>
          <td><Select aria-label={`Role for ${m.email}`} value={m.role} disabled={busy} onChange={(e) => void run(() => callAction('team.changeRole', { ...input, userId: m.userId, role: e.target.value === 'admin' ? 'admin' : 'member' }), 'Role changed.')}><option value="member">Member</option><option value="admin">Admin</option></Select></td>
          <td className="text-right"><Button variant="ghost" disabled={busy} onClick={async () => { if (await ask(`Remove ${m.email}?`, 'They lose access to this newsletter right away.', 'Remove')) void run(() => callAction('team.remove', { ...input, userId: m.userId }), 'Removed from the team.') }}>Remove</Button></td>
        </tr>)}</Table>}
        <h2 className="font-semibold">Pending invitations</h2>
        {!team.data?.invites.length ? <Card><EmptyState title="No pending invitations" body="New invitations appear here until they are accepted or expire." /></Card> : <Table head={<tr><th>Email</th><th className="w-28">Role</th><th className="w-48"><span className="sr-only">Actions</span></th></tr>}>{team.data.invites.map((i) => <tr key={i.id}>
          <td><p className="break-all">{i.email}</p><p className="text-xs text-fg-3">Expires {new Date(i.expiresAt).toLocaleDateString()}</p></td>
          <td><StatusBadge status={i.role} /></td>
          <td><div className="flex justify-end gap-2"><Button size="sm" disabled={busy} onClick={() => void resend(i.id)}>{emailConfigured ? 'Resend' : 'New link'}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await ask(`Revoke the invitation to ${i.email}?`, 'The link in their email stops working.', 'Revoke')) void run(() => callAction('team.revoke', { ...input, inviteId: i.id }), 'Invitation revoked.') }}>Revoke</Button></div></td>
        </tr>)}</Table>}
      </>}
    </>}
  </div>
}

export const teamFeature: Feature = {
  name: 'team',
  settings: [{ to: '/settings/team', label: 'Team' }],
  settingsRoutes: [{ path: 'team', element: <TeamPage /> }],
}
