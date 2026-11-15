import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ActionOutput } from '../../../../server/registry.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, useFeedback } from '../../ui/index.tsx'
import { FieldsForm } from './FieldsForm.tsx'

type Details = ActionOutput<'contacts.get'>
function EditContact({ details, canEdit }: { details: Details; canEdit: boolean }) {
  const { contact: c } = details
  const [name, setName] = useState(c.name)
  const [fields, setFields] = useState(c.fields)
  const [tagId, setTagId] = useState('')
  const definitions = useActionQuery('contactFields.list', { newsletterId: c.newsletterId })
  const tags = useActionQuery('tags.list', { newsletterId: c.newsletterId })
  const update = useAction('contacts.update', { invalidate: ['contacts.get', 'contacts.list', 'segments.count'] })
  const bulk = useAction('contacts.bulk', { invalidate: ['contacts.get', 'contacts.list', 'segments.count'] })
  const { toast } = useFeedback()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try { await update.mutateAsync({ newsletterId: c.newsletterId, contactId: c.id, name, fields, unsetFields: Object.keys(c.fields).filter((key) => !(key in fields)) }); toast('Contact saved.') } catch {}
  }
  const tag = async (operation: 'tag' | 'untag', id: string) => {
    try { await bulk.mutateAsync({ newsletterId: c.newsletterId, contactIds: [c.id], operation, tagIds: [id] }); setTagId('') } catch {}
  }
  return <Card className="flex flex-col gap-5 p-4 sm:p-5">{(update.error || bulk.error || definitions.error || tags.error) && <Banner kind="danger">{update.error?.message ?? bulk.error?.message ?? definitions.error?.message ?? tags.error?.message}</Banner>}<form onSubmit={submit} className="flex flex-col gap-4"><fieldset disabled={!canEdit} className="flex flex-col gap-4"><Field label="Name">{(id) => <Input id={id} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />}</Field><FieldsForm definitions={definitions.data?.fields ?? []} values={fields} onChange={setFields} /></fieldset>{canEdit && <Button type="submit" variant="primary" className="self-start" loading={update.isPending}>Save contact</Button>}</form><div className="flex flex-col gap-3"><h2 className="font-medium">Tags</h2>{details.tags.length ? <div className="flex flex-wrap gap-2">{details.tags.map((t) => <span key={t.id} className="flex items-center gap-2 rounded-lg bg-sunken px-2 py-1 text-sm">{t.name}{canEdit && <button aria-label={'Remove tag ' + t.name} disabled={bulk.isPending} onClick={() => void tag('untag', t.id)}>×</button>}</span>)}</div> : <p className="text-sm text-fg-3">No tags. Add a tag to group this contact with other readers.</p>}{canEdit && <div className="flex gap-2"><Select aria-label="Tag to add" value={tagId} onChange={(e) => setTagId(e.target.value)}><option value="">Choose a tag</option>{tags.data?.tags.filter((t) => !details.tags.some((r) => r.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select><Button disabled={!tagId} loading={bulk.isPending} onClick={() => void tag('tag', tagId)}>Add tag</Button></div>}</div></Card>
}
function ContactDetails({ newsletterId, contactId }: { newsletterId: string; contactId: string }) {
  const { account } = useSession()
  const canEdit = !!(account?.owner || account?.grants[newsletterId] === 'admin')
  const [pages, setPages] = useState<(number | undefined)[]>([undefined])
  const query = useActionQuery('contacts.get', { newsletterId, contactId, beforeEventId: pages.at(-1) })
  const unsubscribe = useAction('contacts.unsubscribe', { invalidate: ['contacts.get', 'contacts.list', 'segments.count'] })
  const remove = useAction('contacts.delete', { invalidate: ['contacts.list', 'segments.count'] })
  const { confirm } = useFeedback()
  const navigate = useNavigate()
  const c = query.data?.contact
  useDocumentTitle(c?.email ?? 'Contact')
  const doUnsubscribe = async () => {
    if (!(await confirm({ title: 'Unsubscribe this contact?', body: 'They will stop receiving this newsletter.', confirmLabel: 'Unsubscribe', danger: true }))) return
    try { await unsubscribe.mutateAsync({ newsletterId, contactId, reason: 'manual' }) } catch {}
  }
  const doDelete = async () => {
    if (!(await confirm({ title: 'Delete this contact?', body: 'Their address will stay protected against future imports.', confirmLabel: 'Delete', danger: true }))) return
    try { await remove.mutateAsync({ newsletterId, contactId }); navigate('/contacts') } catch {}
  }
  return <div className="flex flex-col gap-5"><Link className="text-sm text-accent-fg" to="/contacts">← Contacts</Link>{(query.error || unsubscribe.error || remove.error) && <Banner kind="danger">{query.error?.message ?? unsubscribe.error?.message ?? remove.error?.message}</Banner>}{query.isPending ? <p role="status">Loading contact…</p> : query.data && c && <><PageHeader title={c.email} description={<span>{c.status} · {c.provider} · Added {new Date(c.createdAt).toLocaleDateString()}</span>} action={canEdit && <div className="flex gap-2">{['subscribed', 'unconfirmed'].includes(c.status) && <Button onClick={() => void doUnsubscribe()} loading={unsubscribe.isPending}>Unsubscribe</Button>}<Button variant="danger" onClick={() => void doDelete()} loading={remove.isPending}>Delete</Button></div>} /><EditContact key={c.id + ':' + c.updatedAt} details={query.data} canEdit={canEdit} /><Card className="p-4 sm:p-5"><h2 className="mb-3 font-medium">Timeline</h2>{query.data.events.length ? <ol className="flex flex-col divide-y divide-line">{query.data.events.map((event) => <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="capitalize">{event.type}</span><time className="text-sm text-fg-3" dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString()}</time></li>)}</ol> : <EmptyState title="No activity yet" body="Signups, sends, opens and other activity will appear here." />}<div className="mt-3 flex justify-between"><Button size="sm" disabled={pages.length === 1} onClick={() => setPages(pages.slice(0, -1))}>Newer</Button><Button size="sm" disabled={!query.data.nextEventId} onClick={() => setPages([...pages, query.data.nextEventId ?? undefined])}>Older</Button></div></Card></>}</div>
}
export function ContactPage() {
  const { current } = useSession()
  const { id } = useParams()
  return current && id ? <ContactDetails key={current.id + id} newsletterId={current.id} contactId={id} /> : <EmptyState title="Choose a newsletter" body="Choose the newsletter this contact belongs to." />
}
