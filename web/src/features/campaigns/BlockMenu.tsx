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

export function BlockRow({ block, active, onPick, onHover, id, role }: { block: Block; active?: boolean; onPick(): void; onHover?(): void; id?: string; role: 'menuitem' | 'option' }) {
  return (
    <button
      type="button"
      role={role}
      id={id}
      aria-selected={role === 'option' ? !!active : undefined}
      tabIndex={role === 'option' ? -1 : undefined}
      data-active={active || undefined}
      onMouseMove={onHover}
      onClick={onPick}
      className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors', active ? 'bg-hover' : 'hover:bg-hover focus-visible:bg-hover')}
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
const MAX_HEIGHT = 340

/**
 * The "/" menu. It floats at the caret; the editor keeps focus and drives it with the keyboard.
 * A mousedown anywhere on the panel, rows or scrollbar, is cancelled so the caret stays put.
 */
export function SlashMenu({ anchor, query, index, onIndex, onPick }: {
  /** Viewport box of the "/" character, read again on every scroll. */
  anchor(): { left: number; top: number; bottom: number } | null
  query: string
  index: number
  onIndex(index: number): void
  onPick(block: Block): void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const blocks = filterBlocks(query)
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor()
      const el = panel.current
      if (!a || !el) return
      const gap = 6
      // A phone's keyboard shrinks and pans the visual viewport; the window does not change.
      const visual = window.visualViewport
      const visibleTop = (visual?.offsetTop ?? 0) + 8
      const visibleBottom = (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight) - 8
      const natural = Math.min(MAX_HEIGHT, el.scrollHeight)
      const below = visibleBottom - (a.bottom + gap)
      const above = a.top - gap - visibleTop
      // Below the line when most of it fits there (the list scrolls), else on the roomier side.
      const up = below < Math.min(natural, 200) && above > below
      const maxHeight = Math.max(0, Math.min(MAX_HEIGHT, up ? above : below))
      const height = Math.min(natural, maxHeight)
      setPos({ top: up ? a.top - gap - height : a.bottom + gap, left: Math.max(8, Math.min(a.left, window.innerWidth - WIDTH - 8)), maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [anchor, blocks.length, query])
  useLayoutEffect(() => {
    panel.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [index])
  return createPortal(
    <div ref={panel} id="slash-menu" role="listbox" aria-label="Insert a block" onMouseDown={(e) => e.preventDefault()} className="fixed z-50 overflow-y-auto rounded-xl bg-surface p-1 shadow-pop" style={{ width: WIDTH, maxHeight: pos?.maxHeight ?? MAX_HEIGHT, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      {blocks.length ? blocks.map((block, i) => <BlockRow key={block.id} role="option" id={`slash-item-${i}`} block={block} active={i === index} onHover={() => i !== index && onIndex(i)} onPick={() => onPick(block)} />) : <p className="px-2 py-2 text-[13px] text-fg-3">No block matches “{query}”. Press Esc to keep the text.</p>}
    </div>,
    document.body,
  )
}
