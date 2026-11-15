import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Feature } from '../../app/feature.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader } from '../../ui/index.tsx'

function AccountPage() {
  const { account } = useSession()
  const profile = useActionQuery('account.profile', {})
  const sessions = useActionQuery('account.sessions', {})
  const [name, setName] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [currentPassword, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [code, setCode] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [notice, setNotice] = useState('')
  const signedOut = () => window.location.assign('/signin')
  const save = useAction('account.updateProfile', { invalidate: ['account.profile'], onSuccess: () => setNotice('Profile saved.') })
  const password = useAction('account.changePassword', { onSuccess: signedOut })
  const requestEmail = useAction('account.requestEmailChange', { onSuccess: () => setNotice('Check your new email for a six-digit code.') })
  const confirmEmail = useAction('account.confirmEmailChange', { onSuccess: signedOut })
  const revoke = useAction('account.revokeSession', { invalidate: ['account.sessions'] })
  const remove = useAction('account.delete', { onSuccess: () => setNotice('Deletion has started. Your account and images will be removed.') })
  const error = profile.error || sessions.error || save.error || password.error || requestEmail.error || confirmEmail.error || revoke.error || remove.error
  const submit = (callback: () => void) => (e: FormEvent) => { e.preventDefault(); setNotice(''); callback() }
  return <div className="flex flex-col gap-5">
    <PageHeader title="Account" description={profile.data?.email} />
    {error && <Banner kind="danger">{error.message}</Banner>}{notice && <Banner kind="ok">{notice}</Banner>}
    <Card className="p-5"><form className="flex flex-col gap-3" onSubmit={submit(() => save.mutate({ name: name ?? profile.data?.name ?? '' }))}>
      <h2 className="font-semibold">Profile</h2><Field label="Display name">{(id) => <Input id={id} value={name ?? profile.data?.name ?? ''} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" />}</Field><Button className="self-start" type="submit" loading={save.isPending}>Save name</Button>
    </form></Card>
    <Card className="flex flex-col gap-4 p-5"><h2 className="font-semibold">Email and password</h2>
      <Field label="Current password" hint="Required to change email, change password or delete your account.">{(id) => <Input id={id} type="password" value={currentPassword} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={200} autoComplete="current-password" />}</Field>
      <form className="flex flex-col gap-3" onSubmit={submit(() => requestEmail.mutate({ email, currentPassword }))}><Field label="New email">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}</Field><Button className="self-start" type="submit" disabled={currentPassword.length < 8} loading={requestEmail.isPending}>Send confirmation code</Button></form>
      <form className="flex flex-col gap-3" onSubmit={submit(() => confirmEmail.mutate({ code }))}><Field label="Confirmation code">{(id) => <Input id={id} required pattern="[0-9]{6}" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />}</Field><Button className="self-start" type="submit" loading={confirmEmail.isPending}>Confirm email and sign out</Button></form>
      <form className="flex flex-col gap-3" onSubmit={submit(() => password.mutate({ currentPassword, newPassword }))}><Field label="New password">{(id) => <Input id={id} type="password" required minLength={8} maxLength={200} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />}</Field><Button className="self-start" type="submit" disabled={currentPassword.length < 8} loading={password.isPending}>Change password and sign out</Button></form>
    </Card>
    <Card className="p-5"><h2 className="mb-3 font-semibold">Active sessions</h2>{sessions.data?.length === 0 && <EmptyState title="No active sessions" body="Sign in to start a new session." />}{sessions.data?.map((s) => <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3"><div className="min-w-0 text-sm"><p className="break-words">{s.user_agent || 'Unknown browser'}</p><p className="text-fg-3">{s.ip || 'Unknown address'} · {new Date(s.created_at).toLocaleDateString()}</p></div><Button loading={revoke.isPending} onClick={() => revoke.mutate({ sessionId: s.id })}>Revoke</Button></div>)}</Card>
    {account?.owner && <Card className="p-5"><form className="flex flex-col gap-3" onSubmit={submit(() => { if (confirmation === 'DELETE') remove.mutate({ accountId: account.id, currentPassword, confirmation }) })}><h2 className="font-semibold text-danger">Delete account</h2><p className="text-sm text-fg-2">Permanently removes your newsletters, contacts, campaigns and images. This cannot be undone.</p><Field label="Type DELETE to confirm">{(id) => <Input id={id} required pattern="DELETE" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />}</Field><Button className="self-start" variant="danger" type="submit" loading={remove.isPending} disabled={currentPassword.length < 8 || confirmation !== 'DELETE'}>Delete account permanently</Button></form></Card>}
  </div>
}
export const accountsFeature: Feature = { name: 'accounts', settings: [{ to: '/settings/account', label: 'Account' }], settingsRoutes: [{ path: 'account', element: <AccountPage /> }] }
