import { useActionQuery } from '../../lib/api.ts'
import { Banner, Button, Field, Input, Select } from '../../ui/index.tsx'
import { useCanAdmin } from '../../lib/session.tsx'

export interface SenderValue {
  fromDomainId: string | null
  fromLocal: string | null
  fromName: string | null
}
export const NO_SENDER: SenderValue = { fromDomainId: null, fromLocal: null, fromName: null }

/**
 * Optional sender for one email. Every field left empty uses the newsletter's sender, field by field.
 * Choosing a domain needs admin (domains.senders); other roles see nothing here.
 */
export function SenderOverride({ newsletterId, value, onChange, disabled }: { newsletterId: string; value: SenderValue; onChange: (next: SenderValue) => void; disabled?: boolean }) {
  const canAdmin = useCanAdmin(newsletterId)
  const domains = useActionQuery('domains.senders', { newsletterId }, { enabled: canAdmin })
  if (!canAdmin) return null
  const set = (patch: Partial<SenderValue>) => onChange({ ...value, ...patch })
  const empty = !value.fromDomainId && !value.fromLocal && !value.fromName
  return <details className="rounded-xl border border-line p-3" open={!empty}>
    <summary className="cursor-pointer text-sm font-medium">Sender{empty ? ' (newsletter default)' : ' (custom)'}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-sm text-fg-3">Leave a field empty to use the newsletter&apos;s value. The domain must be verified here and with your email provider. Replies still go to the newsletter&apos;s reply-to address.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name">{(id) => <Input id={id} disabled={disabled} maxLength={200} value={value.fromName ?? ''} onChange={(e) => set({ fromName: e.target.value || null })} />}</Field>
        <Field label="Address before @">{(id) => <Input id={id} disabled={disabled} maxLength={64} value={value.fromLocal ?? ''} onChange={(e) => set({ fromLocal: e.target.value || null })} />}</Field>
        <Field label="Domain">{(id) => <Select id={id} disabled={disabled || domains.isPending} value={value.fromDomainId ?? ''} onChange={(e) => set({ fromDomainId: e.target.value || null })}><option value="">Newsletter domain</option>{domains.data?.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</Select>}</Field>
      </div>
      {domains.error && <Banner kind="danger">{domains.error.message}</Banner>}
      {!empty && <Button size="sm" disabled={disabled} onClick={() => onChange(NO_SENDER)}>Use the newsletter sender</Button>}
    </div>
  </details>
}
