import { useState } from 'react'
import type { Newsletter } from '../../../../server/account/newsletters/index.ts'
import { useAction } from '../../lib/api.ts'
import { useSession } from '../../lib/session.tsx'
import { Banner, Button, Card, EmptyState, Field, Input, Select, Textarea, useFeedback } from '../../ui/index.tsx'
function DesignForm({ newsletter }: { newsletter: Newsletter }) {
  const [theme, setTheme] = useState(newsletter.theme)
  const { account, refreshNewsletters } = useSession()
  const save = useAction('newsletters.update', { invalidate: ['newsletters.list'] })
  const { toast } = useFeedback()
  const canEdit = account?.owner || account?.grants[newsletter.id] === 'admin'
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-4 sm:p-5">
        <form className="flex flex-col gap-4" onSubmit={async (e) => {
          e.preventDefault()
          try {
            await save.mutateAsync({ newsletterId: newsletter.id, theme })
            await refreshNewsletters()
            toast('Design saved.')
          } catch {}
        }}>
          <h2 className="font-semibold">Design</h2>
          {save.error && <Banner kind="danger">{save.error.message}</Banner>}
          <fieldset disabled={!canEdit} className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Accent color">{(id) => <Input id={id} type="color" value={theme.accentColor} onChange={(e) => setTheme({ ...theme, accentColor: e.target.value })} />}</Field>
              <Field label="Background color">{(id) => <Input id={id} type="color" value={theme.backgroundColor} onChange={(e) => setTheme({ ...theme, backgroundColor: e.target.value })} />}</Field>
              <Field label="Text color">{(id) => <Input id={id} type="color" value={theme.textColor} onChange={(e) => setTheme({ ...theme, textColor: e.target.value })} />}</Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Font">{(id) => <Select id={id} value={theme.fontFamily} onChange={(e) => setTheme({ ...theme, fontFamily: e.target.value === 'serif' ? 'serif' : e.target.value === 'monospace' ? 'monospace' : 'sans-serif' })}><option value="sans-serif">Sans serif</option><option value="serif">Serif</option><option value="monospace">Monospace</option></Select>}</Field>
              <Field label="Buttons">{(id) => <Select id={id} value={theme.buttonStyle} onChange={(e) => setTheme({ ...theme, buttonStyle: e.target.value === 'square' ? 'square' : e.target.value === 'pill' ? 'pill' : 'rounded' })}><option value="rounded">Rounded</option><option value="square">Square</option><option value="pill">Pill</option></Select>}</Field>
            </div>
            <Field label="Header text">{(id) => <Textarea id={id} maxLength={2000} value={theme.headerText} onChange={(e) => setTheme({ ...theme, headerText: e.target.value })} />}</Field>
            <Field label="Footer text" hint="The required postal address and unsubscribe link are added separately.">{(id) => <Textarea id={id} maxLength={2000} value={theme.footerText} onChange={(e) => setTheme({ ...theme, footerText: e.target.value })} />}</Field>
          </fieldset>
          {canEdit && <Button type="submit" variant="primary" className="self-start" loading={save.isPending}>Save design</Button>}
        </form>
      </Card>
      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3 text-sm font-medium">Style sample</div>
        <div className="p-6 sm:p-10" style={{ backgroundColor: theme.backgroundColor, color: theme.textColor, fontFamily: theme.fontFamily }}>
          <p className="mb-5 whitespace-pre-wrap text-sm">{theme.headerText || newsletter.name}</p>
          <h3 className="text-xl font-semibold">A note to your readers</h3>
          <p className="my-4">Your words, in your newsletter’s style.</p>
          <span className="inline-block px-5 py-2 text-white" style={{ backgroundColor: theme.accentColor, borderRadius: theme.buttonStyle === 'square' ? 0 : theme.buttonStyle === 'pill' ? 999 : 6 }}>Read more</span>
          {theme.footerText && <p className="mt-6 whitespace-pre-wrap text-sm">{theme.footerText}</p>}
        </div>
      </Card>
    </div>
  )
}
export function DesignPage() {
  const { current } = useSession()
  return current ? <DesignForm key={current.id} newsletter={current} /> : <EmptyState title="Choose a newsletter" body="Create or restore a newsletter before choosing its design." />
}
