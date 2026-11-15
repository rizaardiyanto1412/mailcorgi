import { useState, type FormEvent } from 'react'
import { Filter as FilterIcon } from 'lucide-react'
import type { Filter } from '../../../../server/account/segments/index.ts'
import type { ActionOutput } from '../../../../server/registry.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Spinner, useFeedback } from '../../ui/index.tsx'
import { FilterBuilder } from './FilterBuilder.tsx'
import type { Feature } from '../../app/feature.ts'

type Segment = ActionOutput<'segments.list'>['segments'][number]
function SegmentEditor({ newsletterId, segment, onClose }: { newsletterId: string; segment: Segment | null; onClose: () => void }) {
  const [name, setName] = useState(segment?.name ?? '')
  const [filter, setFilter] = useState<Filter | null>(segment?.filter ?? null)
  const create = useAction('segments.create', { invalidate: ['segments.list'] })
  const update = useAction('segments.update', { invalidate: ['segments.list'] })
  const count = useActionQuery('segments.count', { newsletterId, filter })
  const { toast } = useFeedback()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      if (segment) await update.mutateAsync({ newsletterId, segmentId: segment.id, name, filter: filter ?? { all: [] } })
      else await create.mutateAsync({ newsletterId, name, filter: filter ?? { all: [] } })
      toast('Segment saved.')
      onClose()
    } catch {}
  }
  return <Card className="p-4 sm:p-5"><form onSubmit={submit} className="flex flex-col gap-4"><Field label="Segment name">{(id) => <Input id={id} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field><FilterBuilder newsletterId={newsletterId} value={filter} onChange={setFilter} /><p className="text-sm text-fg-3" aria-live="polite">{count.isFetching ? 'Counting…' : count.data ? `${count.data.count.toLocaleString()} matching contacts` : 'Choose valid conditions to count contacts.'}</p>{count.error && <Banner kind="danger">{count.error.message}</Banner>}{(create.error || update.error) && <Banner kind="danger">{create.error?.message ?? update.error?.message}</Banner>}<div className="flex gap-2"><Button type="submit" variant="primary" loading={create.isPending || update.isPending} disabled={!!count.error}>Save segment</Button><Button onClick={onClose}>Cancel</Button></div></form></Card>
}
function SegmentCount({ newsletterId, filter }: { newsletterId: string; filter: Filter }) {
  const query = useActionQuery('segments.count', { newsletterId, filter })
  return <span className="text-sm text-fg-3">{query.error ? query.error.message : query.data ? `${query.data.count.toLocaleString()} contacts` : 'Counting…'}</span>
}
function SegmentsPage() {
  useDocumentTitle('Segments')
  const { current, account } = useSession()
  const [editing, setEditing] = useState<Segment | 'new' | null>(null)
  const query = useActionQuery('segments.list', { newsletterId: current?.id ?? '' }, { enabled: !!current })
  const remove = useAction('segments.delete', { invalidate: ['segments.list'] })
  const { confirm } = useFeedback()
  if (!current) return <EmptyState title="Choose a newsletter" body="Create a newsletter to save contact filters." />
  const canEdit = account?.owner || account?.grants[current.id] === 'admin'
  return <div className="flex flex-col gap-5"><PageHeader title="Segments" description="Save filters to reuse when you send an issue." action={canEdit && <Button variant="primary" onClick={() => setEditing('new')}>New segment</Button>} />{editing && <SegmentEditor key={current.id + (editing === 'new' ? 'new' : editing.id)} newsletterId={current.id} segment={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}{(query.error || remove.error) && <Banner kind="danger">{query.error?.message ?? remove.error?.message}</Banner>}{query.isPending ? <Spinner /> : !query.data?.segments.length ? <Card><EmptyState title="No segments yet" body="Choose New segment to save a group of contacts by their tags, fields or activity." /></Card> : <div className="grid gap-3">{query.data.segments.map((segment) => <Card key={segment.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="flex flex-col gap-1"><h2 className="font-medium">{segment.name}</h2><SegmentCount newsletterId={current.id} filter={segment.filter} /></div>{canEdit && <div className="flex gap-2"><Button size="sm" onClick={() => setEditing(segment)}>Edit</Button><Button size="sm" variant="ghost" loading={remove.isPending} onClick={async () => { if (await confirm({ title: 'Delete this segment?', body: 'Contacts stay in your newsletter.', confirmLabel: 'Delete', danger: true })) { try { await remove.mutateAsync({ newsletterId: current.id, segmentId: segment.id }) } catch {} } }}>Delete</Button></div>}</Card>)}</div>}</div>
}
export const segmentsFeature: Feature = {
  name: 'segments',
  nav: [{ to: '/segments', label: 'Segments', icon: FilterIcon }],
  routes: [{ path: 'segments', element: <SegmentsPage /> }],
}
