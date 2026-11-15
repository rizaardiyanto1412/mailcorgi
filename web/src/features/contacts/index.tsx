import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Users } from 'lucide-react'
import type { Contact, ContactStatus } from '../../../../server/account/contacts/index.ts'
import type { Filter } from '../../../../server/account/segments/index.ts'
import type { ActionInput } from '../../../../server/registry.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, sourceLabel, Spinner, StatusBadge, statusLabel, Table, useFeedback } from '../../ui/index.tsx'
import { FilterBuilder } from '../segments/FilterBuilder.tsx'
import { FieldsForm } from './FieldsForm.tsx'
import { ContactPage } from './ContactPage.tsx'
import { ContactSettings } from './Settings.tsx'
import { SuppressionsPage } from './Suppressions.tsx'
import type { Feature } from '../../app/feature.ts'

const statuses: ContactStatus[] = ['subscribed', 'unconfirmed', 'unsubscribed', 'bounced', 'complained', 'cleaned']
function AddContact({ newsletterId, onClose }: { newsletterId: string; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Contact['fields']>({})
  const [result, setResult] = useState('')
  const defs = useActionQuery('contactFields.list', { newsletterId })
  const create = useAction('contacts.create', { invalidate: ['contacts.list', 'segments.count'] })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const r = await create.mutateAsync({ newsletterId, email, name, fields })
      if (r.outcome === 'suppressed') setResult('This address opted out or is suppressed. Only the contact can confirm a new subscription.')
      else if (r.outcome === 'limit') setResult('Your account has reached its contact limit. Remove inactive contacts or change your plan.')
      else onClose()
    } catch {}
  }
  return <Card className="p-4"><form onSubmit={submit} className="flex flex-col gap-3"><h2 className="font-medium">Add a contact</h2><Field label="Email">{(id) => <Input id={id} type="email" required maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field><Field label="Name">{(id) => <Input id={id} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />}</Field><FieldsForm definitions={defs.data?.fields ?? []} values={fields} onChange={setFields} /><p className="text-xs text-fg-3">Only add people who have agreed to receive this newsletter.</p>{(create.error || defs.error) && <Banner kind="danger">{create.error?.message ?? defs.error?.message}</Banner>}{result && <Banner>{result}</Banner>}<div className="flex gap-2"><Button type="submit" variant="primary" loading={create.isPending}>Add contact</Button><Button onClick={onClose}>Cancel</Button></div></form></Card>
}
function ContactsPage() {
  const { current } = useSession()
  return current ? <ContactList key={current.id} newsletterId={current.id} /> : <EmptyState title="Choose a newsletter" body="Create a newsletter before adding contacts." />
}
function ContactList({ newsletterId }: { newsletterId: string }) {
  useDocumentTitle('Contacts')
  const { account } = useSession()
  const { confirm } = useFeedback()
  const canEdit = account?.owner || account?.grants[newsletterId] === 'admin'
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ContactStatus | undefined>()
  const [tagId, setTagId] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filter, setFilter] = useState<Filter | null>(null)
  const [sort, setSort] = useState<'createdAt' | 'email' | 'name'>('createdAt')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [selected, setSelected] = useState<string[]>([])
  const [operation, setOperation] = useState<ActionInput<'contacts.bulk'>['operation']>('tag')
  const [bulkTag, setBulkTag] = useState('')
  const tags = useActionQuery('tags.list', { newsletterId })
  const query = useActionQuery('contacts.list', { newsletterId, search: search || undefined, status, tagId: tagId || undefined, filter, sort, direction, cursor: cursors.at(-1) })
  const bulk = useAction('contacts.bulk', { invalidate: ['contacts.list', 'contacts.get', 'segments.count'] })
  const reset = () => { setCursors([undefined]); setSelected([]) }
  const apply = async () => {
    if (['delete', 'unsubscribe'].includes(operation) && !(await confirm({ title: `${operation === 'delete' ? 'Delete' : 'Unsubscribe'} ${selected.length} contacts?`, body: operation === 'delete' ? 'Deleted addresses stay protected against future imports.' : 'They will stop receiving this newsletter.', confirmLabel: operation === 'delete' ? 'Delete' : 'Unsubscribe', danger: true }))) return
    try { await bulk.mutateAsync({ newsletterId, contactIds: selected, operation, tagIds: bulkTag ? [bulkTag] : [] }); setSelected([]) } catch {}
  }
  return <div className="flex min-w-0 flex-col gap-5"><PageHeader title="Contacts" description="The people who receive your newsletter." action={<div className="flex gap-2"><a className="inline-flex h-8 items-center rounded-lg border border-line-strong px-3 text-sm" href={'/api/actions/contacts.export?newsletterId=' + encodeURIComponent(newsletterId)}>Export CSV</a>{canEdit && <Button variant="primary" onClick={() => setAdding(true)}>Add contact</Button>}</div>} />{adding && <AddContact newsletterId={newsletterId} onClose={() => setAdding(false)} />}<Card className="flex flex-col gap-3 p-4"><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Input aria-label="Search contacts" type="search" placeholder="Search name or email" value={search} onChange={(e) => { setSearch(e.target.value); reset() }} /><Select aria-label="Contact status" value={status ?? ''} onChange={(e) => { setStatus(statuses.find((s) => s === e.target.value)); reset() }}><option value="">All statuses</option>{statuses.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select><Select aria-label="Contact tag" value={tagId} onChange={(e) => { setTagId(e.target.value); reset() }}><option value="">All tags</option>{tags.data?.tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</Select><div className="flex gap-2"><Select aria-label="Sort contacts" value={sort} onChange={(e) => { setSort(e.target.value === 'email' ? 'email' : e.target.value === 'name' ? 'name' : 'createdAt'); reset() }}><option value="createdAt">Signup date</option><option value="email">Email</option><option value="name">Name</option></Select><Button aria-label="Reverse sort direction" onClick={() => { setDirection(direction === 'asc' ? 'desc' : 'asc'); reset() }}>{direction === 'asc' ? '↑' : '↓'}</Button></div></div><Button className="self-start" size="sm" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>Advanced filters{filter ? ' •' : ''}</Button>{showFilters && <FilterBuilder newsletterId={newsletterId} value={filter} onChange={(v) => { setFilter(v); reset() }} />}</Card>{(query.error || tags.error || bulk.error) && <Banner kind="danger">{query.error?.message ?? tags.error?.message ?? bulk.error?.message}</Banner>}{canEdit && selected.length > 0 && <Card className="flex flex-wrap items-center gap-2 p-3"><span className="text-sm">{selected.length} selected</span><Select className="max-w-44" aria-label="Bulk operation" value={operation} onChange={(e) => setOperation(e.target.value === 'untag' ? 'untag' : e.target.value === 'delete' ? 'delete' : e.target.value === 'unsubscribe' ? 'unsubscribe' : 'tag')}><option value="tag">Add tag</option><option value="untag">Remove tag</option><option value="unsubscribe">Unsubscribe</option><option value="delete">Delete</option></Select>{['tag', 'untag'].includes(operation) && <Select aria-label="Bulk tag" className="max-w-44" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)}><option value="">Choose tag</option>{tags.data?.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}<Button loading={bulk.isPending} disabled={['tag', 'untag'].includes(operation) && !bulkTag} onClick={() => void apply()}>Apply</Button><Button variant="ghost" onClick={() => setSelected([])}>Clear</Button></Card>}{query.isPending ? <Spinner /> : !query.data?.contacts.length ? <Card><EmptyState icon={<Users />} title={search || status || tagId || filter ? 'No matching contacts' : 'No contacts yet'} body={search || status || tagId || filter ? 'Try a different search or clear your filters.' : 'Add your first contact, import a CSV, or share your signup form.'} /></Card> : <Card className="overflow-hidden"><Table head={<tr>{canEdit && <th className="w-10"><input type="checkbox" aria-label="Select this page" checked={query.data.contacts.every((c) => selected.includes(c.id))} onChange={(e) => setSelected(e.target.checked ? query.data.contacts.map((c) => c.id) : [])} /></th>}<th>Email</th><th>Name</th><th>Status</th><th>Source</th></tr>}>{query.data.contacts.map((c) => <tr key={c.id}>{canEdit && <td><input type="checkbox" aria-label={'Select ' + c.email} checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))} /></td>}<td><Link className="font-medium hover:underline" to={'/contacts/' + c.id}>{c.email}</Link></td><td>{c.name || '—'}</td><td><StatusBadge status={c.status} /></td><td className="whitespace-nowrap text-fg-2">{sourceLabel(c.source)}</td></tr>)}</Table><div className="flex items-center justify-between gap-2 border-t border-line p-3"><Button size="sm" disabled={cursors.length === 1} onClick={() => { setCursors(cursors.slice(0, -1)); setSelected([]) }}>Previous</Button><span className="text-xs text-fg-3">Page {cursors.length}</span><Button size="sm" disabled={!query.data.nextCursor} onClick={() => { setCursors([...cursors, query.data.nextCursor ?? undefined]); setSelected([]) }}>Next</Button></div></Card>}</div>
}
export const contactsFeature: Feature = {
  name: 'contacts',
  nav: [{ to: '/contacts', label: 'Contacts', icon: Users }],
  routes: [{ path: 'contacts', element: <ContactsPage /> }, { path: 'contacts/:id', element: <ContactPage /> }],
  settings: [{ to: '/settings/contacts', label: 'Tags and fields' }, { to: '/settings/suppressions', label: 'Suppressions', role: 'owner' }],
  settingsRoutes: [{ path: 'contacts', element: <ContactSettings /> }, { path: 'suppressions', element: <SuppressionsPage /> }],
}
