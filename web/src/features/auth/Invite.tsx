import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, callAction, setCsrf } from '../../lib/api.ts'
import { useAuth, type Bootstrap } from '../../lib/session.tsx'
import { Banner, Button, Card, Field, Input, Logo } from '../../ui/index.tsx'

export function InvitePage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const { boot, refresh } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [form, setForm] = useState({ email: '', password: '', name: '' })
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (!boot.session) {
        if (mode === 'signin') await api.post('/auth/signin', { email: form.email, password: form.password })
        else if (pending) await api.post('/auth/signup/verify', { email: form.email, code })
        else {
          const result = await api.post<{ pending: boolean }>('/auth/signup', { ...form, inviteToken: token })
          if (result.pending) { setPending(true); return }
        }
        const updated = await api.get<Bootstrap>('/auth/bootstrap')
        setCsrf(updated.session?.csrf ?? '')
        refresh()
      }
      const accepted = await callAction('team.accept', { token })
      await api.post('/auth/account', { accountId: accepted.accountId })
      try { localStorage.setItem(`mc-current:${accepted.accountId}`, accepted.newsletterId) } catch {}
      window.location.assign('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept this invitation.')
    } finally {
      setBusy(false)
    }
  }
  return <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-5 px-4 py-10">
    <Logo size={40} /><h1 className="text-xl font-semibold">Join a newsletter</h1><p className="text-sm text-fg-3">Use the email address that received this invitation. Links expire in 7 days.</p>
    <Card><form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      {error && <Banner kind="danger">{error}</Banner>}
      {!token ? <Banner kind="danger">The invitation link is missing. Open the link in your invitation email.</Banner> : boot.session ? <><p className="break-all text-sm">Signed in as {boot.session.user.email}</p><Button type="submit" variant="primary" loading={busy}>Accept invitation</Button><Button disabled={busy} onClick={async () => { try { await api.post('/auth/signout'); refresh() } catch (err) { setError(err instanceof Error ? err.message : 'Could not sign out.') } }}>Use a different account</Button></> : <>
        {pending ? <Field label="Email code" hint="Enter the 6-digit sign-up code we sent you.">{(id) => <Input id={id} required pattern="\d{6}" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}</Field> : <>
          {mode === 'signup' && <Field label="Your name">{(id) => <Input id={id} required maxLength={120} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>}
          <Field label="Invited email">{(id) => <Input id={id} type="email" required autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Password">{(id) => <Input id={id} type="password" required minLength={mode === 'signup' ? 8 : 1} maxLength={200} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}</Field>
        </>}
        <Button type="submit" variant="primary" loading={busy}>{pending ? 'Verify and accept' : mode === 'signin' ? 'Sign in and accept' : 'Create account and accept'}</Button>
        {!pending && <Button disabled={busy} onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError('') }}>{mode === 'signin' ? 'Create an account instead' : 'Sign in instead'}</Button>}
      </>}
    </form></Card>
  </main>
}
