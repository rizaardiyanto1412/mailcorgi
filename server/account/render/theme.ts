import { z } from 'zod'

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const themeSchema = z.object({
  background: color.default('#f3f4f6'),
  surface: color.default('#ffffff'),
  text: color.default('#20242c'),
  muted: color.default('#596273'),
  accent: color.default('#9a3412'),
  font: z.enum(['sans', 'serif', 'mono']).default('sans'),
  headingSizes: z.tuple([z.number().int().min(24).max(48), z.number().int().min(20).max(40), z.number().int().min(18).max(32)]).default([32, 26, 21]),
  buttonColor: color.default('#9a3412'),
  buttonText: color.default('#ffffff'),
  buttonShape: z.enum(['square', 'rounded', 'pill']).default('rounded'),
  header: z.object({ logo: z.string().max(2048).default(''), title: z.string().max(200).default('') }).default({ logo: '', title: '' }),
  footerText: z.string().max(2000).default('Thanks for reading.'),
})
export type Theme = z.infer<typeof themeSchema>
export const defaultTheme = themeSchema.parse({})
export const fontStacks = { sans: 'Arial, Helvetica, sans-serif', serif: 'Georgia, Times New Roman, serif', mono: 'Courier New, Courier, monospace' }
export const themePresets = [
  { name: 'Corgi', theme: defaultTheme },
  { name: 'Editorial', theme: themeSchema.parse({ font: 'serif', background: '#f5f1e8', text: '#292524', accent: '#854d0e', buttonColor: '#854d0e', buttonShape: 'square' }) },
  { name: 'Ocean', theme: themeSchema.parse({ background: '#eff6ff', accent: '#075985', buttonColor: '#075985', buttonShape: 'pill' }) },
  { name: 'Garden', theme: themeSchema.parse({ background: '#f0fdf4', accent: '#166534', buttonColor: '#166534' }) },
  { name: 'Midnight', theme: themeSchema.parse({ background: '#111827', surface: '#1f2937', text: '#f9fafb', muted: '#d1d5db', accent: '#93c5fd', buttonColor: '#93c5fd', buttonText: '#111827' }) },
]
export function parseTheme(value: unknown): Theme {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return defaultTheme }
  }
  const parsed = themeSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultTheme
}
