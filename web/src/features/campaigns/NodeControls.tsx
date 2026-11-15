import { useEditorState, type Editor } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { Button, Field, Input, Select } from '../../ui/index.tsx'

export function NodeControls({ editor }: { editor: Editor }) {
  const selected = useEditorState({
    editor, selector: ({ editor: e }) => {
      const selection = e.state.selection
      const type = selection instanceof NodeSelection ? selection.node.type.name : e.isActive('callout') ? 'callout' : ''
      return { type, attrs: type ? e.getAttributes(type) : {} }
    }
  })
  if (!['image', 'button', 'embed', 'callout', 'spacer'].includes(selected.type)) return null
  const { type, attrs } = selected
  const update = (key: string, value: string | number) => editor.commands.updateAttributes(type, { [key]: value })
  const field = (key: string, label: string, inputType = 'text') => <Field key={key} label={label}>{(id) => <Input id={id} type={inputType} value={typeof attrs[key] === 'string' || typeof attrs[key] === 'number' ? attrs[key] : ''} onChange={(e) => update(key, inputType === 'number' ? Number(e.target.value) : e.target.value)} />}</Field>
  return <section className="space-y-3 border-t border-line bg-sunken p-4" aria-label="Selected block settings">
    <h3 className="text-sm font-semibold">{({ image: 'Image', button: 'Button', embed: 'Link card', callout: 'Callout', spacer: 'Spacer' })[type]} settings</h3>
    <div className="grid gap-3 sm:grid-cols-2">
      {type === 'image' && <>{field('alt', 'Alt text')}{field('caption', 'Caption')}{field('width', 'Width in pixels', 'number')}{field('href', 'Link address', 'url')}</>}
      {type === 'button' && <>{field('label', 'Label')}{field('href', 'Link address', 'url')}<Field label="Alignment">{(id) => <Select id={id} value={attrs.align} onChange={(e) => update('align', e.target.value)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></Select>}</Field></>}
      {type === 'embed' && <>{field('url', 'Link address', 'url')}{field('title', 'Title')}{field('description', 'Description')}{field('image', 'Image address', 'url')}</>}
      {type === 'callout' && <>{field('emoji', 'Emoji')}<Field label="Tone">{(id) => <Select id={id} value={attrs.tone} onChange={(e) => update('tone', e.target.value)}><option value="info">Information</option><option value="warning">Warning</option><option value="success">Success</option></Select>}</Field></>}
      {type === 'spacer' && field('height', 'Height in pixels', 'number')}
    </div>
    <Button size="sm" variant="ghost" onClick={() => editor.chain().focus().deleteNode(type).run()}>Remove block</Button>
  </section>
}
