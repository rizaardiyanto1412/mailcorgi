import { z } from 'zod'
import { marked, type Token, type Tokens } from 'marked'

export const markSchema = z.object({
  type: z.enum(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight']),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
})
export const nodeSchema = z.object({
  type: z.enum(['doc', 'text', 'hardBreak', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'horizontalRule', 'image', 'button', 'callout', 'divider', 'spacer', 'embed']),
  text: z.string().optional(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  marks: z.array(markSchema).optional(),
  get content() { return z.array(nodeSchema).optional() },
})
export type DocNode = z.infer<typeof nodeSchema>
export type DocMark = z.infer<typeof markSchema>
export const emptyDoc: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] }
export function parseDoc(value: unknown): DocNode {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return emptyDoc }
  }
  const parsed = nodeSchema.safeParse(value)
  return parsed.success ? parsed.data : emptyDoc
}

export function decodeText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? entity
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

function inline(tokens: Token[]): DocNode[] {
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'strong': case 'em': case 'del': {
        const mark: DocMark = { type: token.type === 'strong' ? 'bold' : token.type === 'em' ? 'italic' : 'strike' }
        return inline(token.tokens ?? []).map((n) => ({ ...n, marks: [...n.marks ?? [], mark] }))
      }
      case 'link': return inline(token.tokens ?? []).map((n) => n.type === 'image' ? { ...n, attrs: { ...n.attrs, href: decodeText(token.href) } } : { ...n, marks: [...n.marks ?? [], { type: 'link', attrs: { href: decodeText(token.href) } }] })
      case 'image': return [{ type: 'image', attrs: { src: decodeText(token.href), alt: decodeText(token.text) } }]
      case 'codespan': return [{ type: 'text', text: token.text, marks: [{ type: 'code' }] }]
      case 'br': return [{ type: 'hardBreak' }]
      default: return 'text' in token && typeof token.text === 'string' && token.text ? [{ type: 'text', text: decodeText(token.text) }] : []
    }
  })
}
function flow(nodes: DocNode[], type: 'paragraph' | 'heading', attrs?: DocNode['attrs']): DocNode[] {
  const output: DocNode[] = []
  let content: DocNode[] = []
  const flush = () => {
    if (content.length) {
      output.push({ type, ...(attrs ? { attrs } : {}), content })
      content = []
    }
  }
  for (const node of nodes) {
    if (node.type === 'image') {
      flush()
      output.push(node)
    }
    else content.push(node)
  }
  flush()
  return output
}

function blocks(tokens: Token[]): DocNode[] {
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'space': return []
      case 'heading': return flow(inline(token.tokens ?? []), 'heading', { level: Math.min(3, token.depth) })
      case 'paragraph': return flow(inline(token.tokens ?? []), 'paragraph')
      case 'blockquote': return [{ type: 'blockquote', content: blocks(token.tokens ?? []) }]
      case 'code': return [{ type: 'codeBlock', content: token.text ? [{ type: 'text', text: token.text }] : [] }]
      case 'hr': return [{ type: 'horizontalRule' }]
      case 'list': return [{ type: token.ordered ? 'orderedList' : 'bulletList', attrs: token.ordered ? { start: Number(token.start) || 1 } : {}, content: token.items.map((item: Tokens.ListItem) => ({ type: 'listItem', content: blocks(item.tokens) })) }]
      case 'text': return flow(token.tokens ? inline(token.tokens) : [{ type: 'text', text: decodeText(token.text) }], 'paragraph')
      default: return [{ type: 'paragraph', content: [{ type: 'text', text: token.raw }] }]
    }
  })
}
export const markdownToDoc = (source: string): DocNode => ({ type: 'doc', content: blocks(marked.lexer(source)) })
