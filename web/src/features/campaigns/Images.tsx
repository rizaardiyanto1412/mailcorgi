import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { ApiError, useAction, useActionQuery } from '../../lib/api.ts'
import { useRole } from '../../lib/session.tsx'
import { Banner, Button, EmptyState, IconButton, Modal, Spinner, useFeedback } from '../../ui/index.tsx'

interface Image { id: string; url: string; width: number | null; height: number | null; bytes: number }
interface Usage { campaigns: { id: string; subject: string; status: string; kind: string }[]; settings: boolean }

const where = (usage: Usage) => [
  ...usage.campaigns.map((c) => `“${c.subject || 'Untitled'}” (${c.kind === 'welcome' ? 'welcome email' : c.status})`),
  ...(usage.settings ? ['the newsletter settings'] : []),
].join(', ')

/** The newsletter's uploaded images: pick one to insert it again, or (admins) delete it. */
export function ImageLibrary({ newsletterId, open, onClose, onPick, onUpload }: { newsletterId: string; open: boolean; onClose(): void; onPick(image: Image): void; onUpload(): void }) {
  const role = useRole(newsletterId)
  const canDelete = role === 'owner' || role === 'admin'
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const images = useActionQuery('campaigns.listImages', { newsletterId, cursor, limit: 48 }, { enabled: open })
  const remove = useAction('campaigns.deleteImage', { invalidate: ['campaigns.listImages'] })
  const [error, setError] = useState('')
  const { confirm, toast } = useFeedback()
  const del = async (image: Image) => {
    setError('')
    if (!(await confirm({ title: 'Delete this image?', body: 'It is removed from storage. Emails already sent show a broken image where they used it.', confirmLabel: 'Delete image', danger: true }))) return
    try {
      await remove.mutateAsync({ newsletterId, imageId: image.id })
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'image_in_use') { setError(err instanceof Error ? err.message : 'Could not delete the image.'); return }
      const usage = err.details as Usage
      if (!(await confirm({ title: 'This image is still used', body: `It appears in ${where(usage)}. Deleting it leaves a broken image there.`, confirmLabel: 'Delete anyway', danger: true }))) return
      try {
        await remove.mutateAsync({ newsletterId, imageId: image.id, confirm: true })
      } catch (again) { setError(again instanceof Error ? again.message : 'Could not delete the image.'); return }
    }
    toast('Image deleted')
  }
  return <Modal open={open} onClose={onClose} width={720} title="Images" description="Images uploaded to this newsletter. Choose one to insert it." footer={<div className="flex flex-wrap justify-between gap-2">
    <div className="flex gap-2">{cursor && <Button onClick={() => setCursor(undefined)}>Newest</Button>}{images.data?.next && <Button onClick={() => setCursor(images.data?.next ?? undefined)}>Older</Button>}</div>
    <Button variant="primary" onClick={onUpload}>Upload image</Button>
  </div>}>
    {error && <Banner kind="danger">{error}</Banner>}
    {images.isPending ? <Spinner /> : images.error ? <Banner kind="danger">{images.error.message}</Banner> : !images.data.images.length ? <EmptyState title="No images yet" body="Upload an image, paste one or drop it into the editor. It shows up here for reuse." /> : (
      <ul className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4">
        {images.data.images.map((image) => <li key={image.id} className="group relative overflow-hidden rounded-lg border border-line bg-sunken">
          <button type="button" className="block aspect-square w-full" onClick={() => onPick(image)} aria-label={`Insert image ${image.width ?? ''}×${image.height ?? ''}`}>
            <img src={image.url} alt="" loading="lazy" className="size-full object-contain" />
          </button>
          {canDelete && <div className="absolute top-1 right-1"><IconButton size="sm" label="Delete image" disabled={remove.isPending} onClick={() => void del(image)}><Trash2 /></IconButton></div>}
          <p className="truncate px-2 py-1 text-xs text-fg-3">{image.width && image.height ? `${image.width}×${image.height} · ` : ''}{Math.max(1, Math.round(image.bytes / 1024))} KB</p>
        </li>)}
      </ul>
    )}
  </Modal>
}
