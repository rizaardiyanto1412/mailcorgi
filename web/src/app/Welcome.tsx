import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAction } from '../lib/api.ts'
import { useDocumentTitle, useSession } from '../lib/session.tsx'
import { Banner, Button, Field, Input, Logo } from '../ui/index.tsx'

const slugify = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

/** Creates the first newsletter, or another one from the switcher. */
export function Welcome() {
  useDocumentTitle('New newsletter')
  const { newsletters, setCurrent, refreshNewsletters, boot } = useSession()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const create = useAction('newsletters.create', { invalidate: ['newsletters.list'] })
  const first = newsletters.length === 0
  const finalSlug = slugTouched ? slug : slugify(name)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const created = await create.mutateAsync({ name, slug: finalSlug || undefined })
    await refreshNewsletters()
    setCurrent(created.id)
    navigate('/', { replace: true })
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={40} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{first ? 'Welcome to MailCorgi' : 'New newsletter'}</h1>
          <p className="mt-1 text-sm text-fg-3">{first ? 'Create your first newsletter to get started.' : 'Each newsletter has its own list, archive and settings.'}</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-card">
          {create.error && <Banner kind="danger">{create.error.message}</Banner>}
          <Field label="Name">{(id) => <Input id={id} required autoFocus maxLength={120} placeholder="The Weekly Corgi" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Web address" hint={`${boot.appUrl}/n/${finalSlug || '…'}`}>
            {(id) => (
              <Input
                id={id}
                value={finalSlug}
                maxLength={60}
                pattern="[a-z0-9][a-z0-9\-]{1,58}[a-z0-9]"
                onChange={(e) => {
                  setSlugTouched(true)
                  setSlug(e.target.value.toLowerCase())
                }}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={create.isPending}>
            Create newsletter
          </Button>
          {!first && (
            <Link to="/" className="text-center text-[13px] text-fg-3 hover:text-fg">
              Back
            </Link>
          )}
        </form>
      </div>
    </main>
  )
}
