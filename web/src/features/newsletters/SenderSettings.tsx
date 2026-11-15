import { useState } from 'react'
import type { Newsletter } from '../../../../server/account/newsletters/index.ts'
import { SenderDomainPicker } from '../domains/index.tsx'
import { useAction } from '../../lib/api.ts'
import { useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, Field, FileButton, Input, Textarea, useFeedback } from '../../ui/index.tsx'
export function SenderSettings({ newsletter }: { newsletter: Newsletter }) {
  const { refreshNewsletters, account } = useSession()
  const [fromName, setFromName] = useState(newsletter.fromName)
  const [fromLocal, setFromLocal] = useState(newsletter.fromLocal)
  const [domainId, setDomainId] = useState(newsletter.domainId ?? '')
  const [replyTo, setReplyTo] = useState(newsletter.replyTo)
  const [postalAddress, setPostalAddress] = useState(newsletter.postalAddress)
  const [language, setLanguage] = useState(newsletter.language)
  const [timezone, setTimezone] = useState(newsletter.timezone)
  const [doubleOptIn, setDoubleOptIn] = useState(newsletter.doubleOptIn)
  const [tracking, setTracking] = useState(newsletter.tracking)
  const update = useAction('newsletters.update', { invalidate: ['newsletters.list'] })
  const { toast } = useFeedback()
  const canEdit = account?.owner || account?.grants[newsletter.id] === 'admin'
  return <Card className="p-4 sm:p-5"><form className="flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); try { await update.mutateAsync({ newsletterId: newsletter.id, fromName, fromLocal, domainId: domainId || null, replyTo, postalAddress, language, timezone, doubleOptIn, tracking }); await refreshNewsletters(); toast('Settings saved.') } catch {} }}><h2 className="font-semibold">Sender and subscriptions</h2>{!canEdit && <p className="text-sm text-fg-3">Only newsletter admins and the owner can change these settings.</p>}{update.error && <Banner kind="danger">{update.error.message}</Banner>}<fieldset disabled={!canEdit} className="flex flex-col gap-4"><div className="grid gap-4 sm:grid-cols-2"><Field label="Sender name">{(id) => <Input id={id} maxLength={200} value={fromName} onChange={(e) => setFromName(e.target.value)} />}</Field><Field label="Sender local part" hint="The part before @.">{(id) => <Input id={id} maxLength={64} value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} />}</Field></div><SenderDomainPicker newsletterId={newsletter.id} value={domainId} onChange={setDomainId} /><Field label="Reply-to" hint="Leave empty to use the sender address.">{(id) => <Input id={id} type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />}</Field><Field label="Postal address" hint="Included in the footer of every email.">{(id) => <Textarea id={id} maxLength={2000} value={postalAddress} onChange={(e) => setPostalAddress(e.target.value)} />}</Field><div className="grid gap-4 sm:grid-cols-2"><Field label="Language code" hint="For example: en, id, or en-GB.">{(id) => <Input id={id} required maxLength={35} value={language} onChange={(e) => setLanguage(e.target.value)} />}</Field><Field label="Timezone" hint="For example: UTC or Asia/Jakarta.">{(id) => <Input id={id} required maxLength={100} value={timezone} onChange={(e) => setTimezone(e.target.value)} />}</Field></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={doubleOptIn} onChange={(e) => setDoubleOptIn(e.target.checked)} />Require email confirmation for signups</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={tracking.opens} onChange={(e) => setTracking({ ...tracking, opens: e.target.checked })} />Track opens</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={tracking.clicks} onChange={(e) => setTracking({ ...tracking, clicks: e.target.checked })} />Track clicks</label></fieldset>{canEdit && <Button className="self-start" type="submit" variant="primary" loading={update.isPending}>Save settings</Button>}</form></Card>
}
export function NewsletterImages({ newsletter }: { newsletter: Newsletter }) {
  const { refreshNewsletters, account } = useSession()
  const upload = useAction('newsletters.uploadImage', { invalidate: ['newsletters.list'] })
  const [error, setError] = useState('')
  const canEdit = account?.owner || account?.grants[newsletter.id] === 'admin'
  const load = async (file: File | undefined, kind: 'logo' | 'icon') => {
    if (!file) return
    setError('')
    const contentType = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].find((v) => v === file.type)
    if (!contentType || file.size > 2097152) { setError('Choose a PNG, JPEG, GIF or WebP image under 2 MB.'); return }
    try {
      let binary = ''
      for (const byte of new Uint8Array(await file.arrayBuffer())) binary += String.fromCharCode(byte)
      await upload.mutateAsync({ newsletterId: newsletter.id, kind, contentType: contentType === 'image/png' ? 'image/png' : contentType === 'image/jpeg' ? 'image/jpeg' : contentType === 'image/gif' ? 'image/gif' : 'image/webp', data: btoa(binary) })
      await refreshNewsletters()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not upload the image.') }
  }
  return <Card className="flex flex-col gap-4 p-4 sm:p-5"><h2 className="font-semibold">Logo and icon</h2><p className="text-sm text-fg-3">PNG, JPEG, GIF or WebP, up to 2 MB each.</p>{(error || upload.error) && <Banner kind="danger">{error || upload.error?.message}</Banner>}{(['logo', 'icon'] as const).map((kind) => { const key = kind === 'logo' ? newsletter.logoKey : newsletter.iconKey; return <div key={kind} className="flex flex-wrap items-center gap-4">{key && <img className="size-16 rounded-lg border border-line object-contain" src={`/img/${account?.id}/${key}`} alt={`${newsletter.name} ${kind}`} />}<div className="flex min-w-0 flex-1 flex-col gap-1.5"><p className="text-[13px] font-medium">{kind === 'logo' ? 'Logo' : 'Icon'}</p><FileButton accept="image/png,image/jpeg,image/gif,image/webp" label={key ? `Replace ${kind}` : `Upload ${kind}`} disabled={!canEdit || upload.isPending} onFile={(file) => void load(file, kind)} /></div></div> })}</Card>
}
