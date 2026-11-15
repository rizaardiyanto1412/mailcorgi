import { InvitePage } from './Invite.tsx'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api.ts'
import { useAuth, useDocumentTitle } from '../../lib/session.tsx'
import { Banner, Button, Field, Input, Logo } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={40} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-fg-3">{subtitle}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">{children}</div>
        {footer && <p className="mt-4 text-center text-[13px] text-fg-3">{footer}</p>}
      </div>
    </main>
  )
}

function useSubmit(run: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await run()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, submit }
}

export function SetupPage() {
  useDocumentTitle('Set up')
  const { refresh } = useAuth()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const { error, busy, submit } = useSubmit(async () => {
    await api.post('/auth/setup', form)
    refresh()
  })
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  return (
    <AuthCard title="Welcome to MailCorgi" subtitle="Create the admin account for this install">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Your name">{(id) => <Input id={id} autoComplete="name" required autoFocus value={form.name} onChange={set('name')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={form.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 8 characters.">
          {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthCard>
  )
}

export function SignInPage() {
  useDocumentTitle('Sign in')
  const { boot, refresh } = useAuth()
  const [mode, setMode] = useState<'password' | 'code'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const { error, busy, submit } = useSubmit(async () => {
    if (mode === 'password') await api.post('/auth/signin', { email, password })
    else if (!codeSent) {
      await api.post('/auth/code', { email })
      setCodeSent(true)
      return
    } else await api.post('/auth/signin/code', { email, code })
    refresh()
  })
  return (
    <AuthCard
      title="Sign in to MailCorgi"
      subtitle="Your newsletters, lists and archive"
      footer={
        <>
          {boot.signupOpen && (
            <>
              New here? <Link to="/signup" className="font-medium text-accent-fg">Create an account</Link>.{' '}
            </>
          )}
          <Link to="/reset" className="font-medium text-accent-fg">
            Forgot your password?
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        {mode === 'password' ? (
          <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        ) : codeSent ? (
          <Field label="Code" hint="We emailed you a 6-digit code.">
            {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" required pattern="\d{6}" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
        ) : null}
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          {mode === 'password' ? 'Sign in' : codeSent ? 'Sign in' : 'Email me a code'}
        </Button>
        {boot.cloud && (
          <button
            type="button"
            className="text-center text-[13px] text-fg-3 hover:text-fg"
            onClick={() => {
              setMode(mode === 'password' ? 'code' : 'password')
              setCodeSent(false)
            }}
          >
            {mode === 'password' ? 'Sign in with an emailed code instead' : 'Sign in with a password instead'}
          </button>
        )}
      </form>
    </AuthCard>
  )
}

export function SignUpPage() {
  useDocumentTitle('Sign up')
  const { boot, refresh } = useAuth()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [resent, setResent] = useState(false)
  const { error, busy, submit } = useSubmit(async () => {
    if (!pending) {
      const result = await api.post<{ pending: boolean }>('/auth/signup', form)
      if (result.pending) {
        setPending(true)
        return
      }
    } else await api.post('/auth/signup/verify', { email: form.email, code })
    refresh()
  })
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  if (!boot.signupOpen) {
    return (
      <AuthCard title="Sign-up is by invitation" subtitle="You need an invitation link to join" footer={<Link to="/signin" className="font-medium text-accent-fg">Back to sign in</Link>}>
        <p className="text-sm text-fg-2">Ask the person who runs this install to invite you. Open the invitation link they send you to create your account.</p>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="Create your account" subtitle="Start a newsletter in a minute" footer={<Link to="/signin" className="font-medium text-accent-fg">Already have an account? Sign in</Link>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        {pending ? (
          <>
            <Banner kind="ok">We sent a 6-digit code to {form.email}.</Banner>
            <Field label="Code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" required pattern="\d{6}" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
          </>
        ) : (
          <>
            <Field label="Your name">{(id) => <Input id={id} autoComplete="name" required autoFocus value={form.name} onChange={set('name')} />}</Field>
            <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={form.email} onChange={set('email')} />}</Field>
            <Field label="Password" hint="At least 8 characters.">
              {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />}
            </Field>
          </>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          {pending ? 'Confirm' : 'Create account'}
        </Button>
        {pending && (
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
            <button type="button" className="font-medium text-accent-fg" disabled={busy} onClick={() => void api.post('/auth/signup', form).then(() => setResent(true), () => setResent(false))}>
              Send a new code
            </button>
            <button type="button" className="font-medium text-accent-fg" onClick={() => { setPending(false); setCode(''); setResent(false) }}>
              Use a different email
            </button>
          </div>
        )}
        {resent && <p role="status" className="text-center text-xs text-fg-3">A new code is on its way.</p>}
      </form>
    </AuthCard>
  )
}

export function ResetPage() {
  useDocumentTitle('Reset password')
  const { refresh } = useAuth()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const { error, busy, submit } = useSubmit(async () => {
    if (!sent) {
      await api.post('/auth/reset', { email })
      setSent(true)
      return
    }
    await api.post('/auth/reset/confirm', { email, code, password })
    refresh()
  })
  return (
    <AuthCard title="Reset your password" subtitle="We will email you a code" footer={<Link to="/signin" className="font-medium text-accent-fg">Back to sign in</Link>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required autoFocus disabled={sent} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        {sent && (
          <>
            <Banner kind="ok">If that address has an account, a code is on its way.</Banner>
            <Field label="Code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" required pattern="\d{6}" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <Field label="New password" hint="At least 8 characters.">
              {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
          </>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          {sent ? 'Set new password' : 'Email me a code'}
        </Button>
      </form>
    </AuthCard>
  )
}

export const authFeature: Feature = {
  name: 'auth',
  publicRoutes: [
    { path: '/invite', element: <InvitePage /> },
    { path: '/signin', element: <SignInPage /> },
    { path: '/signup', element: <SignUpPage /> },
    { path: '/reset', element: <ResetPage /> },
    { path: '/setup', element: <SetupPage /> },
  ],
}
