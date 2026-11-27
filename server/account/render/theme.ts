import { z } from 'zod'
import { withPatch } from '../../core/patch.ts'

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const themeFields = {
  background: color, surface: color, text: color, muted: color, accent: color,
  font: z.enum(['sans', 'serif', 'mono']),
  headingSizes: z.tuple([z.number().int().min(24).max(48), z.number().int().min(20).max(40), z.number().int().min(18).max(32)]),
  buttonColor: color, buttonText: color,
  buttonShape: z.enum(['square', 'rounded', 'pill']),
  header: z.object({ logo: z.string().max(2048), title: z.string().max(200) }).partial(),
  footerText: z.string().max(2000),
}
/** A design as a caller sends it: every key, and each header key, is optional. An omitted one keeps the stored value on an update. */
export const themePatchSchema = z.object(themeFields).partial()
export type ThemePatch = z.infer<typeof themePatchSchema>
export type Theme = Required<Omit<ThemePatch, 'header'>> & { header: { logo: string; title: string } }
export const defaultTheme: Theme = {
  background: '#f3f4f6', surface: '#ffffff', text: '#20242c', muted: '#596273', accent: '#9a3412', font: 'sans', headingSizes: [32, 26, 21],
  buttonColor: '#9a3412', buttonText: '#ffffff', buttonShape: 'rounded', header: { logo: '', title: '' }, footerText: 'Thanks for reading.',
}
/** `base` with the keys of `patch` laid over it, the header key by key. */
export function mergeTheme(base: Theme, patch: ThemePatch | undefined): Theme {
  const { header, ...rest } = patch ?? {}
  return { ...withPatch(base, rest as Partial<Theme>), header: withPatch(base.header, header) }
}
/** The whole design with a default for every key a value leaves out: how a stored or one-off design is read. */
export const themeSchema = themePatchSchema.transform((patch): Theme => mergeTheme(defaultTheme, patch))
const preset = (patch: ThemePatch): Theme => mergeTheme(defaultTheme, patch)
export const themePresets = [
  { name: 'Corgi', theme: defaultTheme },
  { name: 'Editorial', theme: preset({ font: 'serif', background: '#f5f1e8', text: '#292524', accent: '#854d0e', buttonColor: '#854d0e', buttonShape: 'square' }) },
  { name: 'Ocean', theme: preset({ background: '#eff6ff', accent: '#075985', buttonColor: '#075985', buttonShape: 'pill' }) },
  { name: 'Garden', theme: preset({ background: '#f0fdf4', accent: '#166534', buttonColor: '#166534' }) },
  { name: 'Midnight', theme: preset({ background: '#111827', surface: '#1f2937', text: '#f9fafb', muted: '#d1d5db', accent: '#93c5fd', buttonColor: '#93c5fd', buttonText: '#111827' }) },
]
export function parseTheme(value: unknown): Theme {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return defaultTheme }
  }
  const parsed = themeSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultTheme
}
export const fontStacks = { sans: 'Arial, Helvetica, sans-serif', serif: 'Georgia, Times New Roman, serif', mono: 'Courier New, Courier, monospace' }
