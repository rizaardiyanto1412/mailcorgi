import { useState, type FormEvent } from 'react'
import type { ActionOutput } from '../../../../server/registry.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, Select, useFeedback } from '../../ui/index.tsx'
function TagRow({ newsletterId, tag }: { newsletterId: string; tag: ActionOutput<'tags.list'>['tags'][number] }) {
  const [name, setName] = useState(tag.name)
  const update = useAction('tags.update', { invalidate: ['tags.list', 'contacts.get'] })
  const remove = useAction('tags.delete', { invalidate: ['tags.list', 'contacts.get', 'contacts.list', 'segments.count'] })
  const { confirm } = useFeedback()
  return <div className="flex flex-col gap-2 border-t border-line py-3"><form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); try { await update.mutateAsync({ newsletterId, tagId: tag.id, name }) } catch {} }}><Input aria-label={'Tag name: ' + tag.name} className="min-w-0 flex-1" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /><Button type="submit" loading={update.isPending} disabled={name === tag.name}>Save</Button><Button variant="ghost" loading={remove.isPending} onClick={async () => { if (await confirm({ title: 'Delete this tag?', body: 'It will be removed from contacts.', confirmLabel: 'Delete', danger: true })) { try { await remove.mutateAsync({ newsletterId, tagId: tag.id }) } catch {} } }}>Delete</Button></form>{(update.error || remove.error) && <Banner kind="danger">{update.error?.message ?? remove.error?.message}</Banner>}</div>
}
function FieldRow({ newsletterId, field }: { newsletterId: string; field: ActionOutput<'contactFields.list'>['fields'][number] }) {
  const [label, setLabel] = useState(field.label)
  const update = useAction('contactFields.update', { invalidate: ['contactFields.list'] })
  const remove = useAction('contactFields.delete', { invalidate: ['contactFields.list', 'contacts.list', 'contacts.get', 'segments.count'] })
  const { confirm } = useFeedback()
  return <div className="flex flex-col gap-2 border-t border-line py-3"><form className="flex flex-wrap items-center gap-2" onSubmit={async (e) => { e.preventDefault(); try { await update.mutateAsync({ newsletterId, fieldId: field.id, label }) } catch {} }}><Input aria-label={'Field label: ' + field.label} className="min-w-0 flex-1" required maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} /><span className="text-xs text-fg-3">{field.key} · {field.type}</span><Button type="submit" loading={update.isPending} disabled={label === field.label}>Save</Button><Button variant="ghost" loading={remove.isPending} onClick={async () => { if (await confirm({ title: 'Delete this field and its values?', body: 'The field will be removed from every contact in this newsletter.', confirmLabel: 'Delete field', danger: true })) { try { await remove.mutateAsync({ newsletterId, fieldId: field.id }) } catch {} } }}>Delete</Button></form>{(update.error || remove.error) && <Banner kind="danger">{update.error?.message ?? remove.error?.message}</Banner>}</div>
}
function SettingsForms({ newsletterId }: { newsletterId: string }) {
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [type, setType] = useState<'text' | 'number' | 'date' | 'boolean'>('text')
  const tags = useActionQuery('tags.list', { newsletterId })
  const fields = useActionQuery('contactFields.list', { newsletterId })
  const addTag = useAction('tags.create', { invalidate: ['tags.list'] })
  const addField = useAction('contactFields.create', { invalidate: ['contactFields.list'] })
  const submitTag = async (e: FormEvent) => { e.preventDefault(); try { await addTag.mutateAsync({ newsletterId, name }); setName('') } catch {} }
  const submitField = async (e: FormEvent) => { e.preventDefault(); try { await addField.mutateAsync({ newsletterId, key, label, type }); setKey(''); setLabel('') } catch {} }
  return <div className="flex flex-col gap-5"><Card className="flex flex-col gap-4 p-4 sm:p-5"><h2 className="font-medium">Tags</h2><form className="flex items-end gap-2" onSubmit={submitTag}><Field className="flex-1" label="New tag">{(id) => <Input id={id} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field><Button type="submit" variant="primary" loading={addTag.isPending}>Add tag</Button></form>{(tags.error || addTag.error) && <Banner kind="danger">{tags.error?.message ?? addTag.error?.message}</Banner>}{tags.data?.tags.length ? <div>{tags.data.tags.map((tag) => <TagRow key={tag.id} newsletterId={newsletterId} tag={tag} />)}</div> : <EmptyState title="No tags yet" body="Add your first tag above, then apply it to contacts." />}</Card><Card className="flex flex-col gap-4 p-4 sm:p-5"><h2 className="font-medium">Custom fields</h2><p className="text-sm text-fg-3">Keys and types stay fixed so saved filters and email merge fields keep working.</p><form className="flex flex-col gap-3" onSubmit={submitField}><div className="grid gap-3 sm:grid-cols-2"><Field label="Label">{(id) => <Input id={id} required maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />}</Field><Field label="Key" hint="Letters, numbers and underscores. Start with a letter.">{(id) => <Input id={id} required pattern="[a-zA-Z][a-zA-Z0-9_]{0,63}" value={key} onChange={(e) => setKey(e.target.value)} />}</Field></div><Field label="Type">{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value === 'number' ? 'number' : e.target.value === 'boolean' ? 'boolean' : e.target.value === 'date' ? 'date' : 'text')}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes or no</option></Select>}</Field><Button className="self-start" type="submit" variant="primary" loading={addField.isPending}>Add field</Button></form>{(fields.error || addField.error) && <Banner kind="danger">{fields.error?.message ?? addField.error?.message}</Banner>}{fields.data?.fields.length ? <div>{fields.data.fields.map((field) => <FieldRow key={field.id} newsletterId={newsletterId} field={field} />)}</div> : <EmptyState title="No custom fields yet" body="Add a field above to store a reader’s preferences or other details." />}</Card></div>
}
export function ContactSettings() {
  const { current, account } = useSession()
  return current && (account?.owner || account?.grants[current.id] === 'admin') ? <SettingsForms key={current.id} newsletterId={current.id} /> : <EmptyState title="Newsletter admin access needed" body="Ask an owner or newsletter admin to manage tags and custom fields." />
}
