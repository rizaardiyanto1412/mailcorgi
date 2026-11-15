import { useState, type FormEvent } from 'react'
import { useAction } from '../../lib/api.ts'
import { Banner, Button, Field, Input, Modal } from '../../ui/index.tsx'

/** Owner only. The name must be typed exactly; the server checks it again. */
export function DeleteNewsletterButton({ newsletter, onDeleted, size }: { newsletter: { id: string; name: string }; onDeleted(): void | Promise<void>; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const remove = useAction('newsletters.delete', { invalidate: ['newsletters.list'] })
  const close = () => { if (remove.isPending) return; setOpen(false); setTyped(''); remove.reset() }
  const matches = typed.trim() === newsletter.name.trim()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!matches) return
    try {
      await remove.mutateAsync({ newsletterId: newsletter.id, confirmName: typed })
      setOpen(false)
      setTyped('')
      await onDeleted()
    } catch {}
  }
  return <>
    <Button variant="danger" size={size} onClick={() => setOpen(true)}>Delete</Button>
    <Modal open={open} onClose={close} title={`Delete ${newsletter.name}?`} description="This permanently deletes its contacts, campaigns, stats, imports, website, images and team access. It cannot be undone.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {remove.error && <Banner kind="danger">{remove.error.message}</Banner>}
        <Field label={`Type ${newsletter.name} to confirm`}>{(id) => <Input id={id} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}</Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={close} disabled={remove.isPending}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={!matches} loading={remove.isPending}>Delete newsletter</Button>
        </div>
      </form>
    </Modal>
  </>
}
