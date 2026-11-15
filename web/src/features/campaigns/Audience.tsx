import type { CampaignAudience } from '../../../../server/account/campaigns/index.ts'
import { useActionQuery } from '../../lib/api.ts'
import { Field, Select, Banner } from '../../ui/index.tsx'

export function AudiencePicker({ newsletterId, value, onChange, disabled }: {
  newsletterId: string
  value: CampaignAudience
  onChange(value: CampaignAudience): void
  disabled: boolean
}) {
  const options = useActionQuery('campaigns.audienceOptions', { newsletterId })
  const mode = value.segmentId ? 'segment' : value.tagIds?.length ? 'tags' : value.engaged ? 'engaged' : 'all'
  return <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
    <h2 className="font-semibold">Audience</h2>
    {options.error && <Banner kind="danger">{options.error.message}</Banner>}
    <Field label="Send to">{(id) => <Select id={id} disabled={disabled} value={mode} onChange={(e) => {
      const exclude = value.exclude
      if (e.target.value === 'segment' && options.data?.segments[0]) onChange({ segmentId: options.data.segments[0].id, exclude })
      else if (e.target.value === 'tags' && options.data?.tags[0]) onChange({ tagIds: [options.data.tags[0].id], exclude })
      else onChange(e.target.value === 'engaged' ? { engaged: true, exclude } : { all: true, exclude })
    }}><option value="all">All subscribers</option><option value="segment" disabled={!options.data?.segments.length}>Saved segment</option><option value="tags" disabled={!options.data?.tags.length}>Tagged subscribers</option><option value="engaged">Most engaged subscribers</option></Select>}</Field>
    {mode === 'segment' && <Field label="Segment">{(id) => <Select id={id} disabled={disabled} value={value.segmentId} onChange={(e) => onChange({ segmentId: e.target.value, exclude: value.exclude })}>{options.data?.segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>}
    {mode === 'tags' && <fieldset disabled={disabled}><legend className="text-sm">Include any of these tags</legend>{options.data?.tags.map((tag) => <label key={tag.id} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={value.tagIds?.includes(tag.id) ?? false} onChange={(e) => {
      const tagIds = e.target.checked ? [...value.tagIds ?? [], tag.id] : value.tagIds?.filter((id) => id !== tag.id) ?? []
      onChange(tagIds.length ? { tagIds, exclude: value.exclude } : { all: true, exclude: value.exclude })
    }} />{tag.name}</label>)}</fieldset>}
    {!!options.data?.tags.length && <fieldset disabled={disabled}><legend className="mb-1 text-sm">Exclude tags</legend>{options.data.tags.map((tag) => <label key={tag.id} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={value.exclude?.tagIds?.includes(tag.id) ?? false} onChange={(e) => onChange({ ...value, exclude: { ...value.exclude, tagIds: e.target.checked ? [...value.exclude?.tagIds ?? [], tag.id] : value.exclude?.tagIds?.filter((id) => id !== tag.id) } })} />{tag.name}</label>)}</fieldset>}
    {!!options.data?.segments.length && <fieldset disabled={disabled}><legend className="mb-1 text-sm">Exclude segments</legend>{options.data.segments.map((segment) => <label key={segment.id} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={value.exclude?.segmentIds?.includes(segment.id) ?? false} onChange={(e) => onChange({ ...value, exclude: { ...value.exclude, segmentIds: e.target.checked ? [...value.exclude?.segmentIds ?? [], segment.id] : value.exclude?.segmentIds?.filter((id) => id !== segment.id) } })} />{segment.name}</label>)}</fieldset>}
    {!options.data?.tags.length && !options.data?.segments.length && <p className="text-xs text-fg-3">Create tags or a saved segment to narrow your audience.</p>}
  </section>
}
