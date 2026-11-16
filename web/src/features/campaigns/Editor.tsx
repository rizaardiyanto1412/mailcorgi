import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Link as LinkIcon, ImagePlus, Undo, Redo, Underline, Strikethrough, Highlighter, List, ListOrdered, Quote, Images, Plus, Braces, ChevronDown } from 'lucide-react'
import { Button, IconButton, Input, Field, Modal, Select, Banner, Popover, MenuItem, MenuDivider } from '../../ui/index.tsx'
import { callAction } from '../../lib/api.ts'
import { campaignExtensions } from './extensions.ts'
import { NodeControls } from './NodeControls.tsx'
import { ImageLibrary } from './Images.tsx'
import { BLOCKS, BlockRow, SlashMenu, filterBlocks, type Block } from './BlockMenu.tsx'
import './editor.css'

function FormatTools({ editor, link }: {
  editor: Editor
  link(): void
}) {
  const active = useEditorState({ editor, selector: ({ editor: e }) => ({ bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'), highlight: e.isActive('highlight'), link: e.isActive('link') }) })
  return <>
    <IconButton label="Bold (⌘B)" active={active.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></IconButton>
    <IconButton label="Italic (⌘I)" active={active.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></IconButton>
    <IconButton label="Underline (⌘U)" active={active.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></IconButton>
    <IconButton label="Strike" active={active.strike} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></IconButton>
    <IconButton label="Highlight" active={active.highlight} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter /></IconButton>
    <IconButton label="Link (⌘K)" active={active.link} onClick={link}><LinkIcon /></IconButton>
  </>
}
function BlockTools({ editor }: { editor: Editor }) {
  const active = useEditorState({ editor, selector: ({ editor: e }) => ({ style: e.isActive('heading', { level: 1 }) ? '1' : e.isActive('heading', { level: 2 }) ? '2' : e.isActive('heading', { level: 3 }) ? '3' : '0', bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote') }) })
  return <>
    <Select aria-label="Text style" className="!h-8 !w-[7.25rem] !text-[13px]" value={active.style} onChange={(e) => {
      const level = Number(e.target.value)
      if (level === 1 || level === 2 || level === 3) editor.chain().focus().setHeading({ level }).run()
      else editor.chain().focus().setParagraph().run()
    }}><option value="0">Text</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option></Select>
    <IconButton label="Bulleted list" active={active.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></IconButton>
    <IconButton label="Numbered list" active={active.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></IconButton>
    <IconButton label="Quote" active={active.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></IconButton>
  </>
}
const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />
const MERGE_FIELDS = [['First name', '{{first_name|friend}}'], ['Name', '{{name|reader}}'], ['Email', '{{email}}'], ['Company', '{{field.company|your company}}'], ['Unsubscribe link', '{{unsubscribe_url}}'], ['Web version link', '{{web_url}}'], ['Preferences link', '{{preferences_url}}']] as const

interface Slash { from: number; query: string }
/** The "/command" the caret sits in, if any: a slash at the start of a block or after a space. */
function slashAt(editor: Editor): Slash | null {
  const { selection } = editor.state
  const { $from } = selection
  if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const match = /(?:^|\s)\/([^\s/]{0,20}(?: [^\s/]{1,20})?)$/.exec(before)
  return match ? { from: $from.pos - match[1].length - 1, query: match[1] } : null
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
  const [slash, setSlashState] = useState<Slash | null>(null)
  const [slashIndex, setSlashIndexState] = useState(0)
  // The editor's key handler is created once, so it reads the menu's state from this ref.
  const menu = useRef<{ slash: Slash | null; index: number; dismissed: number | null }>({ slash: null, index: 0, dismissed: null })
  const setSlash = (next: Slash | null) => {
    if (next?.query !== menu.current.slash?.query) setSlashIndex(0)
    menu.current.slash = next
    setSlashState(next)
  }
  const setSlashIndex = (index: number) => {
    menu.current.index = index
    setSlashIndexState(index)
  }
  // Latest closures for the editor's handlers, which are bound once.
  const live = useRef<{ pickSlash(block: Block): void; openLink(): void; onSave(): void; upload(file: File): Promise<void> } | null>(null)
  const editor = useEditor({
    extensions: campaignExtensions(), content: doc, editable,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Campaign content', 'aria-multiline': 'true' },
      handleKeyDown: (_view, e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          live.current?.onSave()
          return true
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault()
          live.current?.openLink()
          return true
        }
        const open = menu.current.slash
        if (!open) return false
        const blocks = filterBlocks(open.query)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (blocks.length) setSlashIndex((menu.current.index + (e.key === 'ArrowDown' ? 1 : blocks.length - 1)) % blocks.length)
          return true
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && blocks[menu.current.index]) {
          e.preventDefault()
          live.current?.pickSlash(blocks[menu.current.index])
          return true
        }
        if (e.key === 'Escape') {
          menu.current.dismissed = open.from
          setSlash(null)
          return true
        }
        return false
      },
      handlePaste: (_view, e) => {
        const file = e.clipboardData?.files[0]
        if (!file) return false
        void live.current?.upload(file)
        return true
      },
      handleDrop: (_view, e) => {
        const file = e.dataTransfer?.files[0]
        if (!file) return false
        e.preventDefault()
        void live.current?.upload(file)
        return true
      },
    },
    onUpdate: ({ editor: e }) => {
      onChange(e.getJSON())
      // Typing opens the menu. Escape keeps that one slash closed until the caret leaves it.
      const next = slashAt(e)
      if (!next) menu.current.dismissed = null
      setSlash(next && next.from !== menu.current.dismissed ? next : null)
    },
    onSelectionUpdate: ({ editor: e }) => {
      // Moving the caret never opens the menu; it only closes one whose slash the caret left.
      const open = menu.current.slash
      if (open && slashAt(e)?.from !== open.from) setSlash(null)
    },
    onBlur: () => setSlash(null),
  })
  const [library, setLibrary] = useState(false)
  const [dialog, setDialog] = useState<'link' | 'button' | 'embed' | 'merge' | null>(null)
  const [mergeKey, setMergeKey] = useState('first_name')
  const [fallback, setFallback] = useState('friend')
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const openLink = () => {
    setUrl(editor?.getAttributes('link').href ?? '')
    setDialog('link')
  }
  /** Insert an image and select it, so its settings (alt text first) open at once. */
  const placeImage = (attrs: { src: string; width?: number | null; height?: number | null }) => {
    if (!editor) return
    editor.chain().focus().setImage({ src: attrs.src, alt: '', ...(attrs.width && attrs.height ? { width: attrs.width, height: attrs.height } : {}) }).run()
    let at = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && node.attrs.src === attrs.src && !node.attrs.alt) at = pos
    })
    if (at >= 0) editor.commands.setNodeSelection(at)
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
      placeImage({ src: result.url, width: result.width, height: result.height })
    } catch (e) { setError(e instanceof Error ? e.message : 'The upload failed.') }
    finally { setProgress(null) }
  }
  /** Run a block command. With `range`, first remove the typed "/query" it replaces. */
  const insert = (type: string, range?: { from: number; to: number }) => {
    if (!editor) return
    setSlash(null)
    const chain = () => range ? editor.chain().focus().deleteRange(range) : editor.chain().focus()
    if (type === 'paragraph') chain().setParagraph().run()
    else if (type === 'heading1') chain().setHeading({ level: 1 }).run()
    else if (type === 'heading2') chain().setHeading({ level: 2 }).run()
    else if (type === 'heading3') chain().setHeading({ level: 3 }).run()
    else if (type === 'bulletList') chain().toggleBulletList().run()
    else if (type === 'orderedList') chain().toggleOrderedList().run()
    else if (type === 'blockquote') chain().toggleBlockquote().run()
    else if (type === 'codeBlock') chain().toggleCodeBlock().run()
    else if (type === 'image') {
      chain().run()
      fileInput.current?.click()
    }
    else if (type === 'button' || type === 'embed') {
      chain().run()
      setUrl('')
      setLabel('')
      setDescription('')
      setError('')
      setDialog(type)
    }
    else if (type === 'callout') chain().insertContent({ type, attrs: { tone: 'info', emoji: '💡' }, content: [{ type: 'paragraph' }] }).run()
    else chain().insertContent({ type }).run()
  }
  const pickSlash = (block: Block) => {
    const open = menu.current.slash
    if (!editor || !open) return
    insert(block.id, { from: open.from, to: editor.state.selection.from })
  }
  useEffect(() => {
    live.current = { pickSlash, openLink, onSave, upload }
  })
  const slashFrom = slash?.from
  const slashAnchor = useCallback(() => {
    if (!editor || slashFrom === undefined) return null
    try {
      const box = editor.view.coordsAtPos(slashFrom)
      return { left: box.left, top: box.top, bottom: box.bottom }
    } catch { return null }
  }, [editor, slashFrom])
  // Tell assistive technology which row the arrow keys are on, while focus stays in the text.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const dom = editor.view.dom
    if (slash) {
      dom.setAttribute('aria-controls', 'slash-menu')
      dom.setAttribute('aria-activedescendant', `slash-item-${slashIndex}`)
    }
    return () => {
      dom.removeAttribute('aria-controls')
      dom.removeAttribute('aria-activedescendant')
    }
  }, [editor, slash, slashIndex])
  const stats = { words: countWords(doc) }
  if (!editor) return null
  return <div className="mail-editor rounded-xl border border-line bg-surface">
    {editable && <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-xl border-b border-line bg-surface px-2 py-1.5" role="toolbar" aria-label="Editor tools">
      <IconButton label="Undo (⌘Z)" onClick={() => editor.chain().focus().undo().run()}><Undo /></IconButton>
      <IconButton label="Redo (⌘⇧Z)" onClick={() => editor.chain().focus().redo().run()}><Redo /></IconButton>
      <Divider />
      <BlockTools editor={editor} />
      <Divider />
      <FormatTools editor={editor} link={openLink} />
      <Divider />
      <IconButton label="Upload image" onClick={() => fileInput.current?.click()}><ImagePlus /></IconButton>
      <IconButton label="Image library" onClick={() => setLibrary(true)}><Images /></IconButton>
      <Divider />
      <Popover width={280} trigger={({ ref, ...props }) => <Button ref={ref} {...props} size="sm" variant="ghost" icon={<Plus />}>Insert<ChevronDown className="!size-3.5 text-fg-3" aria-hidden /></Button>}>
        {(close) => BLOCKS.map((block) => <BlockRow key={block.id} block={block} onPick={() => { close(); insert(block.id) }} />)}
      </Popover>
      <Popover width={220} trigger={({ ref, ...props }) => <Button ref={ref} {...props} size="sm" variant="ghost" icon={<Braces />}>Personalize<ChevronDown className="!size-3.5 text-fg-3" aria-hidden /></Button>}>
        {(close) => <>
          {MERGE_FIELDS.map(([name, token]) => <MenuItem key={token} onSelect={() => { close(); editor.chain().focus().insertContent(token).run() }}>{name}</MenuItem>)}
          <MenuDivider />
          <MenuItem onSelect={() => { close(); setError(''); setDialog('merge') }}>Custom field…</MenuItem>
        </>}
      </Popover>
    </div>}
    <EditorContent editor={editor} />
    {editable && slash && <SlashMenu anchor={slashAnchor} query={slash.query} index={slashIndex} onIndex={setSlashIndex} onPick={pickSlash} />}
    {editable && <BubbleMenu editor={editor} shouldShow={({ editor: e, state }) => !state.selection.empty && e.isEditable && !e.isActive('image') && !e.isActive('codeBlock') && state.doc.textBetween(state.selection.from, state.selection.to).length > 0}><div className="flex rounded-lg bg-surface p-1 shadow-pop"><FormatTools editor={editor} link={openLink} /></div></BubbleMenu>}
    {progress !== null && <div className="px-4 pb-3" role="status"><p className="mb-1 text-xs text-fg-3">Uploading image…</p><div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress}%` }} /></div></div>}
    {error && dialog === null && <div className="px-4 pb-3"><Banner kind="danger">{error}</Banner></div>}
    {editable && <NodeControls editor={editor} />}
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-line px-4 py-2 text-xs text-fg-3"><span>{stats.words.toLocaleString()} {stats.words === 1 ? 'word' : 'words'}</span>{editable && <span className="hidden sm:inline">Type <kbd className="rounded border border-line bg-sunken px-1 font-sans">/</kbd> for blocks · <kbd className="rounded border border-line bg-sunken px-1 font-sans">⌘S</kbd> to save</span>}</div>
    {editable && <ImageLibrary newsletterId={newsletterId} open={library} onClose={() => setLibrary(false)} onUpload={() => { setLibrary(false); fileInput.current?.click() }} onPick={(image) => {
      setLibrary(false)
      placeImage({ src: image.url, width: image.width, height: image.height })
    }} />}
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
