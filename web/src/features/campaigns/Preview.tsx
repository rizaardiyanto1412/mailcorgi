import { useState } from 'react'
import { Button } from '../../ui/index.tsx'

export function Preview({ email, web }: {
  email: string
  web: string
}) {
  const [mode, setMode] = useState<'email' | 'web'>('email')
  const [mobile, setMobile] = useState(false)
  const [dark, setDark] = useState(false)
  const html = mode === 'email' ? email : web
  const darkCss = '<style>body,table,td{background-color:#1f2937!important;color:#f9fafb!important}a{color:#93c5fd!important}blockquote,pre{background-color:#111827!important}</style>'
  return <section aria-label="Issue preview" className="min-w-0 rounded-xl border border-line bg-sunken">
    <div className="flex flex-wrap gap-2 border-b border-line p-3">
      <Button size="sm" aria-pressed={mode === 'email'} onClick={() => setMode('email')}>Email</Button><Button size="sm" aria-pressed={mode === 'web'} onClick={() => setMode('web')}>Web</Button>
      <Button size="sm" aria-pressed={mobile} onClick={() => setMobile(!mobile)}>{mobile ? 'Phone width' : 'Desktop width'}</Button>
      <Button size="sm" aria-pressed={dark} onClick={() => setDark(!dark)}>{dark ? 'Dark preview' : 'Light preview'}</Button>
    </div>
    <div className="overflow-auto p-2"><iframe title={`${mode} ${mobile ? 'phone' : 'desktop'} preview`} sandbox="" referrerPolicy="no-referrer" srcDoc={dark ? html.replace('</head>', `${darkCss}</head>`) : html} className="mx-auto h-[640px] w-full border-0 bg-white" style={{ maxWidth: mobile ? 375 : 760 }} /></div>
  </section>
}
