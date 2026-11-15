import type { Condition, Filter } from '../../../../server/account/segments/index.ts'
import type { ContactStatus } from '../../../../server/account/contacts/index.ts'
import { useActionQuery } from '../../lib/api.ts'
import { Banner, Button, Input, Select } from '../../ui/index.tsx'

const statuses: ContactStatus[] = ['subscribed', 'unconfirmed', 'unsubscribed', 'bounced', 'complained', 'cleaned']
const customOps: Extract<Condition, { field: 'custom' }>['op'][] = ['eq', 'neq', 'contains', 'gt', 'lt', 'set', 'unset']
const dateOps = ['before', 'after', 'withinDays', 'never'] as const
const engagementOps = ['openedLast', 'clickedLast', 'ignoredLast'] as const
const templates: Condition[] = [
  { field: 'status', in: ['subscribed'] }, { field: 'tag', id: '' },
  { field: 'custom', key: '', op: 'eq', value: '' },
  { field: 'subscribedAt', op: 'withinDays', value: 30 },
  { field: 'lastOpenedAt', op: 'withinDays', value: 30 },
  { field: 'lastClickedAt', op: 'withinDays', value: 30 },
  { field: 'lastSentAt', op: 'withinDays', value: 30 },
  { field: 'source', in: ['manual'] }, { field: 'provider', in: ['gmail'] },
  { field: 'email', op: 'contains', value: '' }, { field: 'engagement', op: 'openedLast', issues: 5 },
]
const fieldLabels = { status: 'Status', tag: 'Tag', custom: 'Custom field', subscribedAt: 'Subscribed', lastOpenedAt: 'Last opened', lastClickedAt: 'Last clicked', lastSentAt: 'Last sent', source: 'Source', provider: 'Inbox provider', email: 'Email', engagement: 'Recent issues' }
interface Options { tags: { id: string; name: string }[]; fields: { key: string; label: string; type: string }[] }
function ConditionEditor({ condition: c, onChange, options }: { condition: Condition; onChange: (v: Filter) => void; options: Options }) {
  const edit = () => {
    switch (c.field) {
      case 'status': return <div className="flex flex-wrap gap-3">{statuses.map((s) => <label key={s} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.in.includes(s)} onChange={(e) => onChange({ ...c, in: e.target.checked ? [...c.in, s] : c.in.filter((v) => v !== s) })} />{s}</label>)}</div>
      case 'tag': return <Select aria-label="Tag" value={c.id} onChange={(e) => onChange({ ...c, id: e.target.value })}><option value="">Choose a tag</option>{options.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
      case 'custom': {
        const type = options.fields.find((f) => f.key === c.key)?.type
        return <>
          <Select aria-label="Custom field" value={c.key} onChange={(e) => onChange({ ...c, key: e.target.value, value: options.fields.find((f) => f.key === e.target.value)?.type === 'number' ? 0 : options.fields.find((f) => f.key === e.target.value)?.type === 'boolean' ? true : '' })}><option value="">Choose a field</option>{options.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
          <Select aria-label="Field comparison" value={c.op} onChange={(e) => onChange({ ...c, op: customOps.find((v) => v === e.target.value) ?? 'eq' })}>{customOps.map((op) => <option key={op}>{op}</option>)}</Select>
          {!['set', 'unset'].includes(c.op) && (type === 'boolean' ? <Select aria-label="Field value" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value === 'true' })}><option value="true">Yes</option><option value="false">No</option></Select> : <Input aria-label="Field value" type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} value={String(c.value ?? '')} onChange={(e) => onChange({ ...c, value: type === 'number' ? Number(e.target.value) : e.target.value })} />)}
        </>
      }
      case 'subscribedAt': case 'lastOpenedAt': case 'lastClickedAt': case 'lastSentAt': return <>
        <Select aria-label="Time comparison" value={c.op} onChange={(e) => onChange({ ...c, op: dateOps.find((v) => v === e.target.value) ?? 'withinDays', value: e.target.value === 'withinDays' ? 30 : Date.now() })}>{dateOps.map((op) => <option key={op} value={op}>{({ before: 'Before', after: 'After', withinDays: 'In the last days', never: 'Never' })[op]}</option>)}</Select>
        {c.op !== 'never' && (c.op === 'withinDays' ? <Input aria-label="Number of days" type="number" min={0} value={c.value ?? 30} onChange={(e) => onChange({ ...c, value: Number(e.target.value) })} /> : <Input aria-label="Date" type="date" value={c.value === undefined ? '' : new Date(c.value).toISOString().slice(0, 10)} onChange={(e) => e.target.value && onChange({ ...c, value: Date.parse(e.target.value + 'T00:00:00Z') })} />)}
      </>
      case 'source': case 'provider': return <Input aria-label={c.field === 'source' ? 'Sources, separated by commas' : 'Providers, separated by commas'} placeholder={c.field === 'source' ? 'manual, import, signup' : 'gmail, outlook, yahoo, icloud, other'} value={c.in.join(', ')} onChange={(e) => onChange({ ...c, in: e.target.value.split(',').map((s) => s.trim()) })} />
      case 'email': return <><Select aria-label="Email comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value === 'endsWith' ? 'endsWith' : 'contains' })}><option value="contains">Contains</option><option value="endsWith">Ends with</option></Select><Input aria-label="Email text" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} /></>
      case 'engagement': return <><Select aria-label="Engagement" value={c.op} onChange={(e) => onChange({ ...c, op: engagementOps.find((v) => v === e.target.value) ?? 'openedLast' })}><option value="openedLast">Opened in last issues</option><option value="clickedLast">Clicked in last issues</option><option value="ignoredLast">Ignored all last issues</option></Select><Input aria-label="Number of issues" type="number" min={1} max={10000} value={c.issues} onChange={(e) => onChange({ ...c, issues: Number(e.target.value) })} /></>
    }
  }
  return <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center [&>select]:sm:max-w-44 [&>input]:sm:max-w-64"><Select aria-label="Filter field" className="sm:max-w-40" value={c.field} onChange={(e) => { const next = templates.find((t) => t.field === e.target.value); if (next) onChange(next) }}>{templates.map((t) => <option key={t.field} value={t.field}>{fieldLabels[t.field]}</option>)}</Select>{edit()}</div>
}
function FilterNode({ value, onChange, onRemove, options, depth = 0 }: { value: Filter; onChange: (v: Filter) => void; onRemove?: () => void; options: Options; depth?: number }) {
  const group = 'all' in value ? value.all : 'any' in value ? value.any : 'not' in value ? [value.not] : null
  if (group) return <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3">
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-fg-3">Match</span><Select aria-label="Combine filters" className="max-w-40" value={'all' in value ? 'all' : 'any' in value ? 'any' : 'not'} onChange={(e) => onChange(e.target.value === 'all' ? { all: group } : e.target.value === 'any' ? { any: group } : { not: group.length === 1 ? group[0] : { all: group } })}><option value="all">All conditions</option><option value="any">Any condition</option><option value="not">Exclude this group</option></Select>{onRemove && <Button size="sm" variant="ghost" onClick={onRemove}>Remove group</Button>}</div>
    {group.map((child, index) => <FilterNode key={index} value={child} depth={depth + 1} options={options} onChange={(v) => { const next = group.map((f, n) => n === index ? v : f); onChange('all' in value ? { all: next } : 'any' in value ? { any: next } : { not: v }) }} onRemove={() => { const next = group.filter((_, n) => n !== index); onChange('all' in value ? { all: next } : 'any' in value ? { any: next } : { all: [] }) }} />)}
    {!('not' in value) && group.length < 20 && <div className="flex gap-2"><Button size="sm" onClick={() => onChange('all' in value ? { all: [...group, templates[0]] } : { any: [...group, templates[0]] })}>Add condition</Button>{depth < 4 && <Button size="sm" onClick={() => onChange('all' in value ? { all: [...group, { any: [templates[0]] }] } : { any: [...group, { all: [templates[0]] }] })}>Add group</Button>}</div>}
  </div>
  if (!('field' in value)) return null
  return <div className="flex min-w-0 items-start gap-2"><ConditionEditor condition={value} onChange={onChange} options={options} />{onRemove && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}</div>
}
/** True when every condition has the values the server needs, so a count or list can run. */
export function isComplete(filter: Filter | null): boolean {
  if (!filter) return true
  if ('all' in filter) return filter.all.every(isComplete)
  if ('any' in filter) return filter.any.every(isComplete)
  if ('not' in filter) return isComplete(filter.not)
  const c: Condition = filter
  switch (c.field) {
    case 'tag': return !!c.id
    case 'custom': return /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(c.key) && (c.op === 'set' || c.op === 'unset' || (c.value !== undefined && c.value !== ''))
    case 'email': return !!c.value
    case 'status': case 'source': case 'provider': return c.in.length > 0
    case 'engagement': return Number.isInteger(c.issues) && c.issues >= 1
    default: return c.op === 'never' || (typeof c.value === 'number' && Number.isFinite(c.value))
  }
}

export function FilterBuilder({ newsletterId, value, onChange }: { newsletterId: string; value: Filter | null; onChange: (v: Filter | null) => void }) {
  const tags = useActionQuery('tags.list', { newsletterId })
  const fields = useActionQuery('contactFields.list', { newsletterId })
  return <div className="flex min-w-0 flex-col gap-2">{(tags.error || fields.error) && <Banner kind="danger">{tags.error?.message ?? fields.error?.message}</Banner>}<FilterNode value={value ?? { all: [] }} onChange={onChange} options={{ tags: tags.data?.tags ?? [], fields: fields.data?.fields ?? [] }} />{value && <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange(null)}>Clear filters</Button>}</div>
}
