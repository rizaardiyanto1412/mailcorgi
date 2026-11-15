import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { Feature } from '../../app/feature.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Table, useFeedback } from '../../ui/index.tsx'

export function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-sunken p-3 text-xs leading-relaxed text-fg"><code>{children}</code></pre>
}

function ApiKeysPage() {
  useDocumentTitle('API & MCP')
  const { account } = useSession()
  const { toast, confirm } = useFeedback()
  const [cursor, setCursor] = useState<string>()
  const keys = useActionQuery('apikeys.list', { limit: 50, cursor }, { enabled: !!account?.owner })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [access, setAccess] = useState<'full' | 'read'>('read')
  const [secret, setSecret] = useState('')
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const create = useAction('apikeys.create', { invalidate: ['apikeys.list'] })
  const edit = useAction('apikeys.rename', { invalidate: ['apikeys.list'] })
  const revoke = useAction('apikeys.revoke', { invalidate: ['apikeys.list'] })
  const origin = window.location.origin
  const close = () => { if (create.isPending) return; setOpen(false); setSecret(''); setName(''); create.reset() }
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); toast('Copied') } catch { toast('Could not copy. Select and copy the text below.', { kind: 'error' }) }
  }
  if (!account?.owner) return <EmptyState title="Only the account owner can manage API keys" body="Ask the owner to create a key for you." />
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="API & MCP" description="Connect apps and AI clients to this account." action={<Button variant="primary" onClick={() => setOpen(true)}>Create key</Button>} />
    <Card>
      {keys.isPending ? <div className="p-6"><Spinner /></div> : keys.error ? <p role="alert" className="p-4 text-danger">{keys.error.message}</p> : keys.data?.keys.length ? <Table head={<tr><th className="px-4 py-3 text-left">Key</th><th>Access</th><th>Last used</th><th><span className="sr-only">Actions</span></th></tr>}>
        {keys.data.keys.map((key) => <tr key={key.id} className="border-t border-line">
          <td className="px-4 py-3"><span className="block font-medium">{key.name}</span><span className="text-xs text-fg-3">••••{key.last4}</span></td>
          <td className="px-2"><Badge>{key.revokedAt ? 'Revoked' : key.access === 'read' ? 'Read only' : 'Full'}</Badge></td>
          <td className="px-2 text-xs text-fg-3">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}</td>
          <td className="px-4"><div className="flex justify-end gap-2">{!key.revokedAt && <>
            <Button size="sm" onClick={() => { edit.reset(); setRename({ id: key.id, name: key.name }) }}>Rename</Button>
            <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={async () => {
              if (!await confirm({ title: `Revoke ${key.name}?`, body: 'Clients using this key will lose access immediately.', confirmLabel: 'Revoke key', danger: true })) return
              try { await revoke.mutateAsync({ keyId: key.id }); toast('Key revoked') } catch (err) { toast(err instanceof Error ? err.message : 'Could not revoke key', { kind: 'error' }) }
            }}>Revoke</Button>
          </>}</div></td>
        </tr>)}
      </Table> : <EmptyState icon={<KeyRound />} title="No API keys yet" body="Create a key to connect your first app or MCP client." action={<Button onClick={() => setOpen(true)}>Create key</Button>} />}
      {(cursor || keys.data?.nextCursor) && <div className="flex gap-2 border-t border-line p-3"><Button disabled={!cursor} onClick={() => setCursor(undefined)}>First page</Button><Button disabled={!keys.data?.nextCursor} onClick={() => setCursor(keys.data?.nextCursor ?? undefined)}>Next page</Button></div>}
    </Card>
    <section className="flex flex-col gap-3"><h2 className="font-semibold">Connect a client</h2><p className="text-sm text-fg-3">Replace YOUR_API_KEY with your saved key. Read-only keys can read data; full keys can also change data and send email. Each key allows 600 requests per minute.</p>
      <h3 className="text-sm font-medium">curl</h3><Code>{`curl '${origin}/api/v1/newsletters' \\\n  -H "Authorization: Bearer YOUR_API_KEY"`}</Code>
      <h3 className="text-sm font-medium">Claude Code</h3><Code>{`claude mcp add --transport http mailcorgi ${origin}/mcp --header "Authorization: Bearer YOUR_API_KEY"`}</Code>
      <h3 className="text-sm font-medium">Cursor</h3><p className="text-sm text-fg-3">Add this server in your MCP settings.</p><Code>{JSON.stringify({ mcpServers: { mailcorgi: { url: `${origin}/mcp`, headers: { Authorization: 'Bearer YOUR_API_KEY' } } } }, null, 2)}</Code>
      <h3 className="text-sm font-medium">Generic MCP client</h3><Code>{`Transport: Streamable HTTP (stateless)\nURL: ${origin}/mcp\nAuthorization: Bearer YOUR_API_KEY\nContent-Type: application/json\nAccept: application/json, text/event-stream`}</Code>
      <a className="text-sm text-accent-fg underline" href="/docs/api">Read the API reference</a>
    </section>
    <Modal open={open} onClose={close} title={secret ? 'Save your API key' : 'Create API key'} description={secret ? 'This secret is shown once. Copy it before closing.' : 'Give this key a name and choose its access.'}>
      {secret ? <div className="flex flex-col gap-3"><Code>{secret}</Code><div className="flex gap-2"><Button variant="primary" onClick={() => void copy(secret)}>Copy key</Button><Button onClick={close}>I saved my key</Button></div></div> : <form className="flex flex-col gap-4" onSubmit={async (event) => {
        event.preventDefault()
        try { const result = await create.mutateAsync({ name, access }); setSecret(result.secret); create.reset() } catch {}
      }}>
        <Field label="Name">{(id) => <Input id={id} autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
        <Field label="Access">{(id) => <Select id={id} value={access} onChange={(event) => setAccess(event.target.value === 'full' ? 'full' : 'read')}><option value="read">Read only</option><option value="full">Full access</option></Select>}</Field>
        {create.error && <p role="alert" className="text-sm text-danger">{create.error.message}</p>}
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>Create key</Button>
      </form>}
    </Modal>
    <Modal open={!!rename} onClose={() => setRename(null)} title="Rename key"><form className="flex flex-col gap-4" onSubmit={async (event) => {
      event.preventDefault()
      if (!rename) return
      try { await edit.mutateAsync({ keyId: rename.id, name: rename.name }); setRename(null) } catch {}
    }}><Field label="Name">{(id) => <Input id={id} autoFocus required maxLength={120} value={rename?.name ?? ''} onChange={(event) => setRename(rename ? { ...rename, name: event.target.value } : null)} />}</Field>{edit.error && <p role="alert" className="text-sm text-danger">{edit.error.message}</p>}<Button type="submit" variant="primary" loading={edit.isPending} disabled={!rename?.name.trim()}>Save name</Button></form></Modal>
  </div>
}

export const apikeysFeature: Feature = {
  name: 'apikeys', settings: [{ to: '/settings/api', label: 'API & MCP', role: 'owner' }],
  settingsRoutes: [{ path: 'api', element: <ApiKeysPage /> }],
}
