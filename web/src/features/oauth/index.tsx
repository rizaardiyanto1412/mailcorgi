import { useMemo, useState } from 'react'
import { PlugZap } from 'lucide-react'
import type { Feature } from '../../app/feature.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useAuth, useDocumentTitle, useSession } from '../../lib/session.tsx'
import { AuthCard } from '../auth/index.tsx'
import { Badge, Button, Card, EmptyState, Field, PageHeader, Select, Spinner, Table, useFeedback } from '../../ui/index.tsx'

type Scope = 'mail:read' | 'mail:full'
const SCOPE_LABEL: Record<Scope, string> = { 'mail:read': 'Read only', 'mail:full': 'Full access' }
const PARAMS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const

/** The consent screen an MCP client opens at /oauth/authorize. Signed-out visitors see the sign-in form here first. */
export function OAuthConsentPage() {
  useDocumentTitle('Connect an app')
  const { boot } = useAuth()
  const request = useMemo(() => {
    const query = new URLSearchParams(window.location.search)
    const out: Record<string, string> = { origin: window.location.origin }
    for (const name of PARAMS) {
      const value = query.get(name)
      if (value !== null) out[name] = value
    }
    return out as { origin: string } & Partial<Record<(typeof PARAMS)[number], string>>
  }, [])
  const described = useActionQuery('oauth.describe', request, { retry: false, staleTime: Infinity, refetchOnWindowFocus: false })
  const decide = useAction('oauth.decide')
  const info = described.data?.ok ? described.data : null
  const [accountId, setAccountId] = useState('')
  const [choice, setChoice] = useState<Scope | ''>('')
  const account = accountId || info?.accounts[0]?.id || ''
  const scope: Scope = choice || info?.requested || 'mail:read'

  const finish = async (approve: boolean) => {
    try {
      const { redirect } = await decide.mutateAsync({ ...request, approve, accountId: account || undefined, grantScope: approve ? scope : undefined })
      window.location.assign(redirect)
    } catch { /* decide.error shows the message */ }
  }

  const user = boot.session?.user.email
  if (described.isPending) return <AuthCard title="Connect an app" subtitle="Checking the request…"><div className="flex justify-center"><Spinner /></div></AuthCard>
  if (described.error) return <AuthCard title="This link does not work" subtitle="The app sent an invalid request"><p role="alert" className="text-sm text-danger">{described.error.message}</p></AuthCard>
  if (described.data && !described.data.ok) {
    const back = described.data.redirect
    return <AuthCard title="This app sent an invalid request" subtitle="Nothing was shared">
      <div className="flex flex-col gap-4">
        <p role="alert" className="text-sm text-danger">{described.data.error}</p>
        <Button variant="primary" onClick={() => window.location.assign(back)}>Return to the app</Button>
      </div>
    </AuthCard>
  }
  if (!info) return null
  return (
    <AuthCard title={`Connect ${info.client.name}`} subtitle={user ? `Signed in as ${user}` : 'Approve access to MailCorgi'} footer={<>After you approve, MailCorgi sends you back to <span className="font-medium text-fg-2">{info.client.redirectTo}</span>.</>}>
      <div className="flex flex-col gap-5">
        <p className="text-sm text-fg-2"><span className="font-medium text-fg">{info.client.name}</span> wants to use MailCorgi through MCP on your behalf.</p>
        {info.accounts.length === 0 ? <p role="alert" className="text-sm text-danger">Only an account owner can connect apps, and you don't own an account here.</p> : <>
          {info.accounts.length > 1 && <Field label="Account">{(id) => <Select id={id} value={account} onChange={(e) => setAccountId(e.target.value)}>{info.accounts.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}</Select>}</Field>}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-medium">Access</legend>
            {(['mail:read', 'mail:full'] as const).map((s) => {
              const disabled = s === 'mail:full' && info.requested === 'mail:read'
              return <label key={s} className={`flex gap-3 rounded-lg border p-3 text-sm ${scope === s ? 'border-accent bg-accent-soft/40' : 'border-line'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
                <input type="radio" name="scope" className="mt-0.5 accent-[var(--accent)]" checked={scope === s} disabled={disabled} onChange={() => setChoice(s)} />
                <span><span className="block font-medium">{SCOPE_LABEL[s]} <code className="ml-1 text-xs text-fg-3">{s}</code></span><span className="text-fg-3">{info.scopes[s]}</span></span>
              </label>
            })}
          </fieldset>
        </>}
        {decide.error && <p role="alert" className="text-sm text-danger">{decide.error.message}</p>}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => void finish(false)} disabled={decide.isPending}>Deny</Button>
          <Button className="flex-1" variant="primary" loading={decide.isPending} disabled={!account} onClick={() => void finish(true)}>Approve</Button>
        </div>
      </div>
    </AuthCard>
  )
}

function ConnectedAppsPage() {
  useDocumentTitle('Connected apps')
  const { account } = useSession()
  const { toast, confirm } = useFeedback()
  const apps = useActionQuery('oauth.listApps', {}, { enabled: !!account?.owner })
  const revoke = useAction('oauth.revokeApp', { invalidate: ['oauth.listApps'] })
  if (!account?.owner) return <EmptyState title="Only the account owner can manage connected apps" />
  const origin = window.location.origin
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="Connected apps" description="MCP clients you approved with OAuth. Disconnect one to stop its access at once." />
    <Card>
      {apps.isPending ? <div className="p-6"><Spinner /></div> : apps.error ? <p role="alert" className="p-4 text-danger">{apps.error.message}</p> : apps.data?.apps.length ? <Table head={<tr><th className="px-4 py-3 text-left">App</th><th>Access</th><th>Last used</th><th><span className="sr-only">Actions</span></th></tr>}>
        {apps.data.apps.map((app) => <tr key={app.id} className="border-t border-line">
          <td className="px-4 py-3"><span className="block font-medium">{app.name}</span><span className="text-xs text-fg-3">Connected {new Date(app.connectedAt).toLocaleDateString()} on {app.host}</span></td>
          <td className="px-2"><Badge tone={app.scope === 'mail:full' ? 'accent' : 'neutral'}>{SCOPE_LABEL[app.scope]}</Badge></td>
          <td className="px-2 text-xs text-fg-3">{app.lastUsedAt ? new Date(app.lastUsedAt).toLocaleString() : 'Never'}</td>
          <td className="px-4"><div className="flex justify-end"><Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={async () => {
            if (!await confirm({ title: `Disconnect ${app.name}?`, body: 'The app loses access immediately. To use it again, connect it again from the app.', confirmLabel: 'Disconnect', danger: true })) return
            try { await revoke.mutateAsync({ grantId: app.id }); toast('App disconnected') } catch (err) { toast(err instanceof Error ? err.message : 'Could not disconnect the app', { kind: 'error' }) }
          }}>Disconnect</Button></div></td>
        </tr>)}
      </Table> : <EmptyState icon={<PlugZap />} title="No connected apps" body={<>In your MCP client, add the server URL <code className="text-fg-2">{origin}/mcp</code>. It opens MailCorgi so you can approve it.</>} />}
    </Card>
  </div>
}

export const oauthFeature: Feature = {
  name: 'oauth',
  settings: [{ to: '/settings/connected-apps', label: 'Connected apps', role: 'owner' }],
  settingsRoutes: [{ path: 'connected-apps', element: <ConnectedAppsPage /> }],
}
