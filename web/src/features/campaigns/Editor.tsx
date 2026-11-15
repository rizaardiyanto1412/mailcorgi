import { useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Link as LinkIcon, ImagePlus, Undo, Redo, Underline, Strikethrough, Highlighter, List, ListOrdered, Code, Quote } from 'lucide-react'
import { Button, IconButton, Input, Field, Modal, Select, Banner } from '../../ui/index.tsx'
import { callAction } from '../../lib/api.ts'
import { campaignExtensions } from './extensions.ts'
import { NodeControls } from './NodeControls.tsx'
import './editor.css'

function FormatTools({ editor, link }: {
  editor: Editor
  link(): void
}) {
  const active = useEditorState({ editor, selector: ({ editor: e }) => ({ bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'), highlight: e.isActive('highlight') }) })
  return <>
    <IconButton label="Bold (⌘B)" active={active.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></IconButton>
    <IconButton label="Italic (⌘I)" active={active.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></IconButton>
    <IconButton label="Underline (⌘U)" active={active.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></IconButton>
    <IconButton label="Strike" active={active.strike} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></IconButton>
    <IconButton label="Highlight" active={active.highlight} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter /></IconButton>
    <IconButton label="Link (⌘K)" onClick={link}><LinkIcon /></IconButton>
  </>
}
const textOf = (node: JSONContent): string => (node.text ?? '') + ' ' + (node.content ?? []).map(textOf).join(' ')
const countWords = (doc: JSONContent) => textOf(doc).split(/\s+/).filter(Boolean).length
interface Props {
  newsletterId: string
  doc: JSONContent
  onChange(doc: JSONContent): void
  onSave(): void
  editable: boolean
}
export function CampaignEditor({ newsletterId, doc, onChange, onSave, editable }: Props) {
  const [slash, setSlash] = useState(false)
  const [dialog, setDialog] = useState<'link' | 'button' | 'embed' | 'merge' | null>(null)
  const [mergeKey, setMergeKey] = useState('first_name')
  const [fallback, setFallback] = useState('friend')
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [alt, setAlt] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const openLink = () => {
    setUrl(editor?.getAttributes('link').href ?? '')
    setDialog('link')
  }
  const upload = async (file: File) => {
    if (progress !== null) return
    setError('')
    setProgress(0)
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Images must be no larger than 5 MB.')
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onprogress = (e) => e.lengthComputable && setProgress(Math.round(e.loaded / e.total * 40))
        reader.onerror = () => reject(new Error('Could not read this image.'))
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1]) : reject(new Error('Could not read this image.'))
        reader.readAsDataURL(file)
      })
      const bitmap = await createImageBitmap(file)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      setProgress(50)
      const result = await callAction('campaigns.uploadImage', { newsletterId, data, ...dimensions })
      setProgress(100)
      editor?.chain().focus().setImage({ src: result.url, alt, width: result.width, height: result.height }).run()
      setAlt('')
    } catch (e) { setError(e instanceof Error ? e.message : 'The upload failed.') }
    finally { setProgress(null) }
  }
  const editor = useEditor({
    extensions: campaignExtensions(), content: doc, editable,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Campaign content', 'aria-multiline': 'true' },
      handleKeyDown: (_view, e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          onSave()
          return true
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault()
          openLink()
          return true
        }
        if (e.key === '/' && editor?.state.selection.$from.parent.textContent === '') {
          e.preventDefault()
          setSlash(true)
          return true
        }
        if (e.key === 'Escape') setSlash(false)
        return false
      },
      handlePaste: (_view, e) => {
        const file = e.clipboardData?.files[0]
        if (!file) return false
        void upload(file)
        return true
      },
      handleDrop: (_view, e) => {
        const file = e.dataTransfer?.files[0]
        if (!file) return false
        e.preventDefault()
        void upload(file)
        return true
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getJSON()),
  })
  const stats = { words: countWords(doc) }
  if (!editor) return null
  const insert = (type: string) => {
    setSlash(false)
    if (type === 'heading') editor.chain().focus().toggleHeading({ level: 2 }).run()
    else if (type === 'bulletList') editor.chain().focus().toggleBulletList().run()
    else if (type === 'orderedList') editor.chain().focus().toggleOrderedList().run()
    else if (type === 'blockquote') editor.chain().focus().toggleBlockquote().run()
    else if (type === 'codeBlock') editor.chain().focus().toggleCodeBlock().run()
    else if (type === 'image') fileInput.current?.click()
    else if (type === 'button' || type === 'embed') {
      setUrl('')
      setLabel('')
      setDescription('')
      setDialog(type)
    }
    else if (type === 'callout') editor.chain().focus().insertContent({ type, attrs: { tone: 'info', emoji: '💡' }, content: [{ type: 'paragraph' }] }).run()
    else editor.chain().focus().insertContent({ type }).run()
  }
  return <div className="mail-editor rounded-xl border border-line bg-surface">
    {editable && <div className="flex flex-wrap items-center gap-1 border-b border-line p-2" role="toolbar" aria-label="Editor tools">
      <FormatTools editor={editor} link={openLink} />
      <IconButton label="Undo (⌘Z)" onClick={() => editor.chain().focus().undo().run()}><Undo /></IconButton>
      <IconButton label="Redo (⌘⇧Z)" onClick={() => editor.chain().focus().redo().run()}><Redo /></IconButton>
      <IconButton label="Bulleted list" onClick={() => insert('bulletList')}><List /></IconButton>
      <IconButton label="Numbered list" onClick={() => insert('orderedList')}><ListOrdered /></IconButton>
      <IconButton label="Quote" onClick={() => insert('blockquote')}><Quote /></IconButton>
      <IconButton label="Code block" onClick={() => insert('codeBlock')}><Code /></IconButton>
      <IconButton label="Upload image" onClick={() => fileInput.current?.click()}><ImagePlus /></IconButton>
      <Button size="sm" onClick={() => setSlash(!slash)}>Insert block /</Button>
      <Select aria-label="Insert merge field" className="!w-44" value="" onChange={(e) => { if (e.target.value) editor.chain().focus().insertContent(e.target.value).run() }}>
        <option value="">Merge field…</option><option value="{{first_name|friend}}">First name</option><option value="{{name|reader}}">Name</option><option value="{{email}}">Email</option><option value="{{field.company|your company}}">Company</option><option value="{{unsubscribe_url}}">Unsubscribe URL</option><option value="{{web_url}}">Web URL</option><option value="{{preferences_url}}">Preferences URL</option>
      </Select>
      <Button size="sm" onClick={() => setDialog('merge')}>Custom merge field</Button>
    </div>}
    {slash && <div role="menu" aria-label="Insert a block" className="flex flex-wrap gap-2 border-b border-line bg-sunken p-3">
      {['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'image', 'button', 'callout', 'divider', 'horizontalRule', 'spacer', 'embed'].map((type) => <Button role="menuitem" key={type} size="sm" onClick={() => insert(type)}>{({ bulletList: 'Bulleted list', orderedList: 'Numbered list', codeBlock: 'Code block', horizontalRule: 'Rule', embed: 'Link card' } as Record<string, string>)[type] ?? type[0].toUpperCase() + type.slice(1)}</Button>)}
      <Button size="sm" variant="ghost" onClick={() => setSlash(false)}>Close</Button>
    </div>}
    <EditorContent editor={editor} />
    {editable && <NodeControls editor={editor} />}
    {editable && <BubbleMenu editor={editor}><div className="flex rounded-lg border border-line bg-surface p-1 shadow-pop"><FormatTools editor={editor} link={openLink} /></div></BubbleMenu>}
    {progress !== null && <div className="px-4 pb-3" role="status"><p className="text-xs">Uploading image…</p><progress className="w-full" max={100} value={progress} /></div>}
    {error && <Banner kind="danger">{error}</Banner>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-3 text-xs text-fg-3"><span>{stats?.words ?? 0} words · ⌘S to save</span>{editable && <Input aria-label="Alt text for the next image" placeholder="Alt text for the next image" className="!w-64" value={alt} onChange={(e) => setAlt(e.target.value)} />}</div>
    <input type="file" aria-label="Upload an image" accept="image/png,image/jpeg,image/gif,image/webp" hidden ref={fileInput} onChange={(e) => {
      if (e.target.files?.[0]) void upload(e.target.files[0])
      e.target.value = ''
    }} />
    <Modal open={dialog !== null} onClose={() => setDialog(null)} title={dialog === 'merge' ? 'Insert merge field' : dialog === 'link' ? 'Edit link' : dialog === 'button' ? 'Insert button' : 'Insert link card'} footer={<Button variant="primary" onClick={() => {
      if (dialog === 'merge') {
        if (!/^(first_name|name|email|field\.[a-zA-Z0-9_]+)$/.test(mergeKey) || /[{}]/.test(fallback)) {
          setError('Use a supported field name and a fallback without braces.')
          return
        }
        editor.chain().focus().insertContent({ type: 'text', text: `{{${mergeKey}${fallback ? `|${fallback}` : ''}}}` }).run()
        setError('')
        setDialog(null)
        return
      }
      if (url && !/^https?:\/\/\S+$/i.test(url)) {
        setError('Enter a full http or https address.')
        return
      }
      if (dialog === 'link') {
        if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        else editor.chain().focus().unsetLink().run()
      }
      else if (dialog === 'button') editor.chain().focus().insertContent({ type: 'button', attrs: { href: url, label: label || 'Read more', align: 'left' } }).run()
      else editor.chain().focus().insertContent({ type: 'embed', attrs: { url, title: label || url, description } }).run()
      setError('')
      setDialog(null)
    }}>Apply</Button>}>
      <div className="space-y-3">{dialog === 'merge' ? <><Field label="Field name" hint="first_name, name, email, or field.your_key">{(id) => <Input id={id} value={mergeKey} onChange={(e) => setMergeKey(e.target.value)} />}</Field><Field label="Fallback">{(id) => <Input id={id} value={fallback} onChange={(e) => setFallback(e.target.value)} />}</Field></> : <><Field label="Address">{(id) => <Input id={id} type="url" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>
        {dialog !== 'link' && <Field label="Label">{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} />}</Field>}
        {dialog === 'embed' && <Field label="Description">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>}
      </>}{error && <Banner kind="danger">{error}</Banner>}</div>
    </Modal>
  </div>
}
