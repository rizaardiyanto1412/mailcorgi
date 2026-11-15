import { escapeHtml, fontStacks, parseTheme } from '../render/index.ts'

export interface PageInput {
  newsletter: { name: string; theme: string }
  title: string
  lines: string[]
  form?: { action: string; button: string; danger?: boolean; secondary?: { href: string; label: string } }
}

/** A small server-rendered page in the newsletter's colors: unsubscribe, preferences and keep. */
export function themedPage(input: PageInput): string {
  const theme = parseTheme(JSON.parse(input.newsletter.theme || '{}'))
  const font = fontStacks[theme.font]
  const button = (label: string) => `<button type="submit" style="font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:${theme.buttonShape === 'pill' ? 999 : theme.buttonShape === 'square' ? 0 : 6}px;background:${theme.buttonColor};color:${theme.buttonText};cursor:pointer">${escapeHtml(label)}</button>`
  const form = input.form ? `<form method="post" action="${escapeHtml(input.form.action)}" style="margin-top:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><input type="hidden" name="confirm" value="1">${button(input.form.button)}${input.form.secondary ? `<a href="${escapeHtml(input.form.secondary.href)}" style="color:${theme.accent}">${escapeHtml(input.form.secondary.label)}</a>` : ''}</form>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${escapeHtml(input.title)} · ${escapeHtml(input.newsletter.name)}</title></head><body style="margin:0;background:${theme.background};color:${theme.text};font-family:${font};font-size:16px;line-height:1.5"><main style="max-width:520px;margin:0 auto;padding:40px 16px"><div style="background:${theme.surface};border-radius:12px;padding:28px"><p style="margin:0 0 8px;color:${theme.muted};font-size:13px">${escapeHtml(input.newsletter.name)}</p><h1 style="margin:0 0 12px;font-size:22px">${escapeHtml(input.title)}</h1>${input.lines.map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('')}${form}</div></main></body></html>`
}
