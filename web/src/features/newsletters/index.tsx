import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Palette, PenLine } from 'lucide-react'
import { useAction } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, Field, Input, StubPage, Textarea, useFeedback } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

function NewsletterSettings() {
  const { current } = useSession()
  return current ? <NewsletterForm key={current.id} /> : null
}

function NewsletterForm() {
  useDocumentTitle('Newsletter settings')
  const { current, boot, refreshNewsletters, setCurrent, newsletters } = useSession()
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
    await update.mutateAsync({ newsletterId: current.id, name, description })
    await refreshNewsletters()
    toast('Saved.')
  }
  const moveSlug = async (e: FormEvent) => {
    e.preventDefault()
    if (slug === current.slug) return
    if (!(await confirm({ title: 'Change the web address?', body: 'Links to the old address stop working.', confirmLabel: 'Change address' }))) return
    await setSlugAction.mutateAsync({ newsletterId: current.id, slug })
    await refreshNewsletters()
    toast('Address changed.')
  }
  const doArchive = async () => {
    if (!(await confirm({ title: `Archive ${current.name}?`, body: 'It leaves the switcher and its public site goes away. You can bring it back later.', confirmLabel: 'Archive', danger: true }))) return
    await archive.mutateAsync({ newsletterId: current.id })
    await refreshNewsletters()
    const next = newsletters.find((n) => n.id !== current.id)
    if (next) setCurrent(next.id)
    navigate('/')
  }

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
            <Button type="submit" variant="primary" loading={update.isPending}>
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
            <Button type="submit" loading={setSlugAction.isPending} disabled={slug === current.slug}>
              Change address
            </Button>
          </div>
        </form>
      </Card>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="text-[15px] font-semibold">Archive</h2>
          <p className="text-[13px] text-fg-3">Stops sending and hides the public site. Contacts and issues stay.</p>
        </div>
        <Button variant="danger" onClick={() => void doArchive()} loading={archive.isPending}>
          Archive newsletter
        </Button>
      </Card>
    </div>
  )
}

export const newslettersFeature: Feature = {
  name: 'newsletters',
  settings: [
    { to: '/settings/newsletter', label: 'Newsletter', icon: PenLine },
    { to: '/settings/design', label: 'Design', icon: Palette },
    { to: '/settings/authors', label: 'Authors' },
  ],
  settingsRoutes: [
    { path: 'newsletter', element: <NewsletterSettings /> },
    { path: 'design', element: <StubPage title="Design" body="Colors, fonts, buttons, header and footer for your emails and site." /> },
    { path: 'authors', element: <StubPage title="Authors" body="People who write issues, with a name, bio and avatar." /> },
  ],
}
