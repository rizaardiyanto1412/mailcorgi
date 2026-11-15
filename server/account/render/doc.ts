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

function inline(tokens: Token[]): DocNode[] {
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'strong': case 'em': case 'del': {
        const mark: DocMark = { type: token.type === 'strong' ? 'bold' : token.type === 'em' ? 'italic' : 'strike' }
        return inline(token.tokens ?? []).map((n) => ({ ...n, marks: [...n.marks ?? [], mark] }))
      }
      case 'link': return inline(token.tokens ?? []).map((n) => ({ ...n, marks: [...n.marks ?? [], { type: 'link', attrs: { href: token.href } }] }))
      case 'image': return [{ type: 'image', attrs: { src: token.href, alt: token.text } }]
      case 'codespan': return [{ type: 'text', text: token.text, marks: [{ type: 'code' }] }]
      case 'br': return [{ type: 'hardBreak' }]
      default: return 'text' in token && typeof token.text === 'string' && token.text ? [{ type: 'text', text: token.text }] : []
    }
  })
}
function blocks(tokens: Token[]): DocNode[] {
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'space': return []
      case 'heading': return [{ type: 'heading', attrs: { level: Math.min(3, token.depth) }, content: inline(token.tokens ?? []) }]
      case 'paragraph': return [{ type: 'paragraph', content: inline(token.tokens ?? []) }]
      case 'blockquote': return [{ type: 'blockquote', content: blocks(token.tokens ?? []) }]
      case 'code': return [{ type: 'codeBlock', content: token.text ? [{ type: 'text', text: token.text }] : [] }]
      case 'hr': return [{ type: 'horizontalRule' }]
      case 'list': return [{ type: token.ordered ? 'orderedList' : 'bulletList', attrs: token.ordered ? { start: Number(token.start) || 1 } : {}, content: token.items.map((item: Tokens.ListItem) => ({ type: 'listItem', content: blocks(item.tokens) })) }]
      case 'text': return [{ type: 'paragraph', content: token.tokens ? inline(token.tokens ?? []) : [{ type: 'text', text: token.text }] }]
      default: return [{ type: 'paragraph', content: [{ type: 'text', text: token.raw }] }]
    }
  })
}
export const markdownToDoc = (source: string): DocNode => ({ type: 'doc', content: blocks(marked.lexer(source)) })
