import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { PenLine } from 'lucide-react'
import { AuthorsPage } from './Authors.tsx'
import { SenderSettings, NewsletterImages } from './SenderSettings.tsx'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Textarea, useFeedback } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

function NewsletterSettings() {
  const { current, account, refreshNewsletters, setCurrent } = useSession()
  const all = useActionQuery('newsletters.list', { includeArchived: true })
  const restore = useAction('newsletters.unarchive', { invalidate: ['newsletters.list'] })
  const archived = all.data?.newsletters.filter((n) => n.archivedAt !== null) ?? []
  return <div className="flex flex-col gap-5"><PageHeader title="Newsletter" description={current ? `Name, address, sender and images for ${current.name}.` : 'Name, address, sender and images.'} />{current ? <><NewsletterForm key={current.id} /><SenderSettings key={current.id + '-sender'} newsletter={current} /><NewsletterImages newsletter={current} /></> : <Card><EmptyState title="No active newsletter" body="Restore an archived newsletter below or create a new one from the switcher." /></Card>}{account?.owner && <Card className="flex flex-col gap-3 p-5"><h2 className="font-semibold">Archived newsletters</h2>{(all.error || restore.error) && <Banner kind="danger">{all.error?.message ?? restore.error?.message}</Banner>}{archived.length ? archived.map((n) => <div key={n.id} className="flex items-center justify-between gap-3"><span>{n.name}</span><Button loading={restore.isPending} onClick={async () => { try { await restore.mutateAsync({ newsletterId: n.id }); await refreshNewsletters(); setCurrent(n.id) } catch {} }}>Restore</Button></div>) : <p className="text-sm text-fg-3">No archived newsletters. You can archive an active newsletter from its settings.</p>}</Card>}</div>
}

function NewsletterForm() {
  useDocumentTitle('Newsletter settings')
  const { current, account, boot, refreshNewsletters, setCurrent, newsletters } = useSession()
  const { toast, confirm } = useFeedback()
  const navigate = useNavigate()
  const [name, setName] = useState(current?.name ?? '')
  const [description, setDescription] = useState(current?.description ?? '')
  const [slug, setSlug] = useState(current?.slug ?? '')
  const update = useAction('newsletters.update', { invalidate: ['newsletters.list'] })
  const setSlugAction = useAction('newsletters.setSlug', { invalidate: ['newsletters.list'] })
  const archive = useAction('newsletters.archive', { invalidate: ['newsletters.list'] })
  if (!current) return null

  const save = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await update.mutateAsync({ newsletterId: current.id, name, description })
      await refreshNewsletters()
      toast('Saved.')
    } catch {}
  }
  const moveSlug = async (e: FormEvent) => {
    e.preventDefault()
    if (slug === current.slug) return
    if (!(await confirm({ title: 'Change the web address?', body: 'Links to the old address stop working.', confirmLabel: 'Change address' }))) return
    try {
      await setSlugAction.mutateAsync({ newsletterId: current.id, slug })
      await refreshNewsletters()
      toast('Address changed.')
    } catch {}
  }
  const doArchive = async () => {
    if (!(await confirm({ title: `Archive ${current.name}?`, body: 'It leaves the switcher and its public site goes away. You can bring it back later.', confirmLabel: 'Archive', danger: true }))) return
    try {
    await archive.mutateAsync({ newsletterId: current.id })
    await refreshNewsletters()
    const next = newsletters.find((n) => n.id !== current.id)
    if (next) setCurrent(next.id)
    navigate('/settings/newsletter')
    } catch {}
  }

  const canEdit = account?.owner || account?.grants[current.id] === 'admin'
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <form onSubmit={save} className="flex flex-col gap-4">
          <h2 className="text-[15px] font-semibold">Identity</h2>
          {update.error && <Banner kind="danger">{update.error.message}</Banner>}
          <Field label="Name">{(id) => <Input id={id} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Description" hint="Shown on the public site and in the signup form.">
            {(id) => <Textarea id={id} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <div>
            <Button type="submit" variant="primary" loading={update.isPending} disabled={!canEdit}>
              Save
            </Button>
          </div>
        </form>
      </Card>
      <Card className="p-5">
        <form onSubmit={moveSlug} className="flex flex-col gap-4">
          <h2 className="text-[15px] font-semibold">Web address</h2>
          {setSlugAction.error && <Banner kind="danger">{setSlugAction.error.message}</Banner>}
          <Field label="Slug" hint={`${boot.appUrl}/n/${slug || '…'}`}>
            {(id) => <Input id={id} required maxLength={60} pattern="[a-z0-9][a-z0-9-]{1,58}[a-z0-9]" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />}
          </Field>
          <div>
            <Button type="submit" loading={setSlugAction.isPending} disabled={!canEdit || slug === current.slug}>
              Change address
            </Button>
          </div>
        </form>
      </Card>
      {archive.error && <Banner kind="danger">{archive.error.message}</Banner>}
      {account?.owner && <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="text-[15px] font-semibold">Archive</h2>
          <p className="text-[13px] text-fg-3">Stops sending and hides the public site. Contacts and issues stay.</p>
        </div>
        <Button variant="danger" onClick={() => void doArchive()} loading={archive.isPending}>
          Archive newsletter
        </Button>
      </Card>}
    </div>
  )
}

export const newslettersFeature: Feature = {
  name: 'newsletters',
  settings: [
    { to: '/settings/newsletter', label: 'Newsletter', icon: PenLine },
    { to: '/settings/authors', label: 'Authors' },
  ],
  settingsRoutes: [
    { path: 'newsletter', element: <NewsletterSettings /> },
    { path: 'authors', element: <AuthorsPage /> },
  ],
}
