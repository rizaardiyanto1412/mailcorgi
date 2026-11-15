import { Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'

const attrs = (defaults: Record<string, string | number | null>) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, {
  default: value, parseHTML: (el: HTMLElement) => {
    const raw = el.getAttribute(`data-${key}`) ?? el.getAttribute(key)
    return typeof value === 'number' ? Number(raw) || value : raw ?? value
  }
}]))
const ButtonNode = Node.create({
  name: 'button', group: 'block', atom: true,
  addAttributes: () => attrs({ label: 'Read more', href: '', align: 'left' }),
  parseHTML: () => [{ tag: 'div[data-mail-node="button"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-mail-node': 'button', class: 'mail-button' }), HTMLAttributes.label],
})
const Callout = Node.create({
  name: 'callout', group: 'block', content: 'block+', defining: true,
  addAttributes: () => attrs({ tone: 'info', emoji: '💡' }),
  parseHTML: () => [{ tag: 'aside[data-mail-node="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ['aside', mergeAttributes(HTMLAttributes, { 'data-mail-node': 'callout', class: 'mail-callout' }), 0],
})
const Divider = Node.create({
  name: 'divider', group: 'block', atom: true,
  parseHTML: () => [{ tag: 'div[data-mail-node="divider"]' }],
  renderHTML: () => ['div', { 'data-mail-node': 'divider', class: 'mail-divider' }],
})
const Spacer = Node.create({
  name: 'spacer', group: 'block', atom: true,
  addAttributes: () => attrs({ height: 24 }),
  parseHTML: () => [{ tag: 'div[data-mail-node="spacer"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-mail-node': 'spacer', class: 'mail-spacer' }), 'Space'],
})
const Embed = Node.create({
  name: 'embed', group: 'block', atom: true,
  addAttributes: () => attrs({ url: '', title: '', description: '', image: '' }),
  parseHTML: () => [{ tag: 'div[data-mail-node="embed"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-mail-node': 'embed', class: 'mail-embed' }), ['strong', {}, HTMLAttributes.title || HTMLAttributes.url], ['p', {}, HTMLAttributes.description]],
})
const NewsletterImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), ...attrs({ width: 600, height: null, href: '', caption: '' }) }
  },
})
export function campaignExtensions() {
  return [StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, protocols: ['http', 'https'], HTMLAttributes: { rel: 'noopener noreferrer' } } }), Placeholder.configure({ placeholder: 'Start writing, or type / for a block…' }), Highlight, NewsletterImage, ButtonNode, Callout, Divider, Spacer, Embed]
}
