import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { ActionOutput } from '../../../../server/registry.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, FileButton, Input, PageHeader, Spinner, Textarea, useFeedback } from '../../ui/index.tsx'
type Author = ActionOutput<'authors.list'>['authors'][number]
function AuthorForm({ newsletterId, author, onClose }: { newsletterId: string; author: Author | null; onClose: () => void }) {
  const [name, setName] = useState(author?.name ?? '')
  const [slug, setSlug] = useState(author?.slug ?? '')
  const [bio, setBio] = useState(author?.bio ?? '')
  const [website, setWebsite] = useState(author?.links.website ?? '')
  const create = useAction('authors.create', { invalidate: ['authors.list'] })
  const update = useAction('authors.update', { invalidate: ['authors.list'] })
  return <Card className="p-4 sm:p-5"><form className="flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); const input = { newsletterId, name, slug, bio, links: { ...author?.links, website: website || undefined } }; const links: Record<string, string> = {}; for (const [k, v] of Object.entries(input.links)) if (v) links[k] = v; try { if (author) await update.mutateAsync({ ...input, links, authorId: author.id }); else await create.mutateAsync({ ...input, links }); onClose() } catch {} }}><h2 className="font-semibold">{author ? 'Edit author' : 'New author'}</h2>{(create.error || update.error) && <Banner kind="danger">{create.error?.message ?? update.error?.message}</Banner>}<Field label="Name">{(id) => <Input id={id} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field><Field label="Slug">{(id) => <Input id={id} required pattern="[a-z0-9][a-z0-9-]{0,59}" maxLength={60} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />}</Field><Field label="Bio">{(id) => <Textarea id={id} maxLength={2000} value={bio} onChange={(e) => setBio(e.target.value)} />}</Field><Field label="Website">{(id) => <Input id={id} type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />}</Field><div className="flex gap-2"><Button variant="primary" type="submit" loading={create.isPending || update.isPending}>Save author</Button><Button onClick={onClose}>Cancel</Button></div></form></Card>
}
function AvatarUpload({ author, newsletterId }: { author: Author; newsletterId: string }) {
  const { account } = useSession()
  const upload = useAction('authors.uploadAvatar', { invalidate: ['authors.list'] })
  const [error, setError] = useState('')
  return <div className="flex flex-col gap-2">{author.avatarKey && <img src={`/img/${account?.id}/${author.avatarKey}`} alt={author.name} className="size-12 rounded-full object-cover" />}<div className="flex flex-col gap-1.5"><p className="text-[13px] font-medium">Avatar</p><FileButton accept="image/png,image/jpeg,image/gif,image/webp" label={author.avatarKey ? 'Replace avatar' : 'Upload avatar'} disabled={upload.isPending} onFile={async (file) => {
    setError('')
    if (file.size > 2097152 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { setError('Choose a PNG, JPEG, GIF or WebP image under 2 MB.'); return }
    try {
      let binary = ''
      for (const byte of new Uint8Array(await file.arrayBuffer())) binary += String.fromCharCode(byte)
      await upload.mutateAsync({ newsletterId, authorId: author.id, data: btoa(binary), contentType: file.type === 'image/png' ? 'image/png' : file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/gif' ? 'image/gif' : 'image/webp' })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not upload the avatar.') }
  }} /></div>{(error || upload.error) && <Banner kind="danger">{error || upload.error?.message}</Banner>}</div>
}
export function AuthorsPage() {
  const { current, account } = useSession()
  const query = useActionQuery('authors.list', { newsletterId: current?.id ?? '' }, { enabled: !!current })
  const remove = useAction('authors.delete', { invalidate: ['authors.list'] })
  const [editing, setEditing] = useState<Author | 'new' | null>(null)
  const { confirm } = useFeedback()
  if (!current) return <EmptyState title="Choose a newsletter" body="Create or restore a newsletter before adding authors." />
  const canEdit = account?.owner || account?.grants[current.id] === 'admin'
  return <div className="flex flex-col gap-5"><PageHeader title="Authors" description="People credited on issues and the public website." action={canEdit && <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>Add author</Button>} />{(query.error || remove.error) && <Banner kind="danger">{query.error?.message ?? remove.error?.message}</Banner>}{editing && <AuthorForm key={current.id + (editing === 'new' ? 'new' : editing.id)} newsletterId={current.id} author={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}{query.isPending ? <Spinner /> : query.data?.authors.length ? query.data.authors.map((a) => <Card key={a.id} className="flex flex-wrap items-start justify-between gap-3 p-4"><div className="min-w-0 flex-1"><h3 className="font-medium">{a.name}</h3><p className="mt-1 whitespace-pre-wrap text-sm text-fg-3">{a.bio}</p>{canEdit && <AvatarUpload author={a} newsletterId={current.id} />}</div>{canEdit && <div className="flex gap-2"><Button size="sm" onClick={() => setEditing(a)}>Edit</Button><Button size="sm" variant="ghost" loading={remove.isPending} onClick={async () => { if (await confirm({ title: 'Delete this author?', confirmLabel: 'Delete', danger: true })) { try { await remove.mutateAsync({ newsletterId: current.id, authorId: a.id }) } catch {} } }}>Delete</Button></div>}</Card>) : <Card><EmptyState title="No authors yet" body="Add an author to show who writes each issue." /></Card>}</div>
}
