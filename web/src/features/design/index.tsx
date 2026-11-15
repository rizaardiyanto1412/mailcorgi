import { useState } from 'react'
import type { Feature } from '../../app/feature.ts'
import { themePresets, themeSchema, type Theme } from '../../../../server/account/render/theme.ts'
import { useAction, useActionQuery } from '../../lib/api.ts'
import { useDocumentTitle, useSession } from '../../lib/session.tsx'
import { Banner, Button, EmptyState, Field, Input, PageHeader, Select, Spinner, Textarea } from '../../ui/index.tsx'
import { Preview } from '../campaigns/Preview.tsx'

function DesignPage() {
  useDocumentTitle('Design')
  const { current } = useSession()
  const design = useActionQuery('campaigns.getTheme', { newsletterId: current?.id ?? '' }, { enabled: !!current })
  if (!current) return <EmptyState title="Choose a newsletter" body="Create a newsletter to design your emails and web archive." />
  return design.isPending ? <Spinner /> : design.error ? <Banner kind="danger">{design.error.message}</Banner> : <ThemeEditor key={current.id} newsletterId={current.id} initial={design.data.theme} />
}
function ThemeEditor({ newsletterId, initial }: {
  newsletterId: string
  initial: Theme
}) {
  const [theme, setTheme] = useState(initial)
  const [saved, setSaved] = useState(false)
  const [validation, setValidation] = useState('')
  const preview = useActionQuery('campaigns.previewDesign', { newsletterId, theme: themeSchema.safeParse(theme).success ? theme : initial })
  const update = useAction('campaigns.updateTheme', { invalidate: ['campaigns.getTheme', 'campaigns.preview'], onSuccess: () => setSaved(true) })
  function change(next: Theme) {
    setTheme(next)
    setSaved(false)
    setValidation('')
  }
  const colors = ['background', 'surface', 'text', 'muted', 'accent', 'buttonColor', 'buttonText'] satisfies (keyof Theme)[]
  return <div className="flex flex-col gap-5">
    <PageHeader title="Design" description="Colors, fonts and layout for your emails and website." action={<Button variant="primary" loading={update.isPending} onClick={() => {
      const parsed = themeSchema.safeParse(theme)
      if (!parsed.success) {
        setValidation('Check the design values before saving.')
        return
      }
      update.mutate({ newsletterId, theme: parsed.data })
    }}>Save design</Button>} />
    {(validation || update.error) && <Banner kind="danger">{validation || update.error?.message}</Banner>}
    {saved && <Banner kind="ok">Design saved.</Banner>}
    <div className="flex flex-wrap gap-2" aria-label="Design presets">{themePresets.map((preset) => <Button key={preset.name} onClick={() => change(preset.theme)}>{preset.name}</Button>)}</div>
    <div className="grid items-start gap-6 lg:grid-cols-[320px_1fr]"><div className="space-y-4 rounded-xl border border-line bg-surface p-4">
      <div className="grid grid-cols-2 gap-3">{colors.map((key) => <Field key={key} label={({ buttonColor: 'Button', buttonText: 'Button text', background: 'Background', surface: 'Content background', text: 'Text', muted: 'Secondary text', accent: 'Links' })[key]}>{(id) => <Input id={id} type="color" value={theme[key]} onChange={(e) => change({ ...theme, [key]: e.target.value })} />}</Field>)}</div>
      <Field label="Font">{(id) => <Select id={id} value={theme.font} onChange={(e) => {
        const font = e.target.value
        if (font === 'sans' || font === 'serif' || font === 'mono') change({ ...theme, font })
      }}><option value="sans">Arial / Helvetica</option><option value="serif">Georgia / Times</option><option value="mono">Courier</option></Select>}</Field>
      <div className="grid grid-cols-3 gap-2">{([0, 1, 2] as const).map((index) => <Field key={index} label={`Heading ${index + 1}`}>{(id) => <Input id={id} type="number" min={[24, 20, 18][index]} max={[48, 40, 32][index]} value={theme.headingSizes[index]} onChange={(e) => {
        const sizes: Theme['headingSizes'] = [...theme.headingSizes]
        sizes[index] = Number(e.target.value)
        change({ ...theme, headingSizes: sizes })
      }} />}</Field>)}</div>
      <Field label="Button shape">{(id) => <Select id={id} value={theme.buttonShape} onChange={(e) => {
        const buttonShape = e.target.value
        if (buttonShape === 'square' || buttonShape === 'rounded' || buttonShape === 'pill') change({ ...theme, buttonShape })
      }}><option value="square">Square</option><option value="rounded">Rounded</option><option value="pill">Pill</option></Select>}</Field>
      <Field label="Header title">{(id) => <Input id={id} maxLength={200} value={theme.header.title} onChange={(e) => change({ ...theme, header: { ...theme.header, title: e.target.value } })} />}</Field>
      <Field label="Logo address" hint="Use an https image address.">{(id) => <Input id={id} type="url" maxLength={2048} value={theme.header.logo} onChange={(e) => change({ ...theme, header: { ...theme.header, logo: e.target.value } })} placeholder="https://example.com/logo.png" />}</Field>
      <Field label="Footer text">{(id) => <Textarea id={id} maxLength={2000} value={theme.footerText} onChange={(e) => change({ ...theme, footerText: e.target.value })} />}</Field>
    </div><div>{preview.error ? <Banner kind="danger">{preview.error.message}</Banner> : preview.data ? <Preview email={preview.data.email.html} web={preview.data.web.html} /> : <Spinner />}</div></div>
  </div>
}
export const designFeature: Feature = { name: 'design', settings: [{ to: '/settings/design', label: 'Design' }], settingsRoutes: [{ path: 'design', element: <DesignPage /> }] }
