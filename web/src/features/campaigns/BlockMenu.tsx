import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Code, Heading1, Heading2, Heading3, ImagePlus, Lightbulb, Link2, List, ListOrdered, Minus, MousePointerClick, MoveVertical, Pilcrow, Quote } from 'lucide-react'
import { cx } from '../../ui/index.tsx'

export interface Block {
  id: string
  label: string
  hint: string
  icon: ReactNode
  /** Extra words the filter matches, besides the label. */
  keywords: string
}

export const BLOCKS: Block[] = [
  { id: 'paragraph', label: 'Text', hint: 'Plain paragraph', icon: <Pilcrow />, keywords: 'paragraph body' },
  { id: 'heading1', label: 'Heading 1', hint: 'Issue title', icon: <Heading1 />, keywords: 'h1 title' },
  { id: 'heading2', label: 'Heading 2', hint: 'Section heading', icon: <Heading2 />, keywords: 'h2 section' },
  { id: 'heading3', label: 'Heading 3', hint: 'Small heading', icon: <Heading3 />, keywords: 'h3 subsection' },
  { id: 'bulletList', label: 'Bulleted list', hint: 'A simple list', icon: <List />, keywords: 'unordered ul points' },
  { id: 'orderedList', label: 'Numbered list', hint: 'Steps in order', icon: <ListOrdered />, keywords: 'ordered ol steps' },
  { id: 'blockquote', label: 'Quote', hint: 'Words from someone else', icon: <Quote />, keywords: 'blockquote citation' },
  { id: 'callout', label: 'Callout', hint: 'A highlighted note', icon: <Lightbulb />, keywords: 'note tip info box' },
  { id: 'image', label: 'Image', hint: 'Upload from your device', icon: <ImagePlus />, keywords: 'picture photo upload' },
  { id: 'button', label: 'Button', hint: 'A link readers can tap', icon: <MousePointerClick />, keywords: 'cta link action' },
  { id: 'embed', label: 'Link card', hint: 'A link with a title and summary', icon: <Link2 />, keywords: 'embed bookmark preview video' },
  { id: 'divider', label: 'Divider', hint: 'A line between sections', icon: <Minus />, keywords: 'rule line separator hr' },
  { id: 'spacer', label: 'Spacer', hint: 'Empty vertical space', icon: <MoveVertical />, keywords: 'space gap blank' },
  { id: 'codeBlock', label: 'Code block', hint: 'Fixed-width text', icon: <Code />, keywords: 'pre snippet monospace' },
]

export const filterBlocks = (query: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return BLOCKS
  const starts = BLOCKS.filter((b) => b.label.toLowerCase().startsWith(q))
  const rest = BLOCKS.filter((b) => !starts.includes(b) && `${b.label} ${b.keywords}`.toLowerCase().includes(q))
  return [...starts, ...rest]
}

export function BlockRow({ block, active, onPick, onHover, id }: { block: Block; active?: boolean; onPick(): void; onHover?(): void; id?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      id={id}
      data-active={active || undefined}
      // Keep the caret in the editor: a mousedown on the row would blur it first.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors', active ? 'bg-hover' : 'hover:bg-hover')}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-2 [&>svg]:size-4" aria-hidden>{block.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">{block.label}</span>
        <span className="block truncate text-xs text-fg-3">{block.hint}</span>
      </span>
    </button>
  )
}

const WIDTH = 280

/** The "/" menu. It floats at the caret; the editor keeps focus and drives it with the keyboard. */
export function SlashMenu({ anchor, query, index, onIndex, onPick }: {
  /** Viewport box of the "/" character, read again on every scroll. */
  anchor(): { left: number; top: number; bottom: number } | null
  query: string
  index: number
  onIndex(index: number): void
  onPick(block: Block): void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const blocks = filterBlocks(query)
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor()
      const height = panel.current?.offsetHeight ?? 0
      if (!a) return
      const gap = 6
      const below = a.bottom + gap
      const top = below + height > window.innerHeight - 8 && a.top - gap - height > 8 ? a.top - gap - height : below
      setPos({ top, left: Math.max(8, Math.min(a.left, window.innerWidth - WIDTH - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, blocks.length])
  useLayoutEffect(() => {
    panel.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [index])
  return createPortal(
    <div ref={panel} id="slash-menu" role="menu" aria-label="Insert a block" className="fixed z-50 max-h-[min(340px,calc(100vh-16px))] overflow-y-auto rounded-xl bg-surface p-1 shadow-pop" style={{ width: WIDTH, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      {blocks.length ? blocks.map((block, i) => <BlockRow key={block.id} id={`slash-item-${i}`} block={block} active={i === index} onHover={() => i !== index && onIndex(i)} onPick={() => onPick(block)} />) : <p className="px-2 py-2 text-[13px] text-fg-3">No block matches “{query}”. Press Esc to keep the text.</p>}
    </div>,
    document.body,
  )
}
