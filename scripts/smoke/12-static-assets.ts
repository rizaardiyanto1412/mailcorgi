import type { SmokeContext } from '../smoke-context.ts'

/** Hashed build files are immutable, a missing one is a 404, and client routes get the SPA shell. */
export default async function step({ base, expect }: SmokeContext) {
  const shell = await fetch(`${base}/campaigns`)
  expect(shell.status === 200 && (shell.headers.get('content-type') ?? '').includes('text/html'), `a client route gets the SPA shell (${shell.status})`)
  const html = await shell.text()
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  expect(asset, 'the shell links a hashed script')
  const hashed = await fetch(base + asset)
  await hashed.arrayBuffer()
  expect(hashed.status === 200 && /max-age=31536000/.test(hashed.headers.get('cache-control') ?? '') && /immutable/.test(hashed.headers.get('cache-control') ?? ''), `a hashed asset is immutable (${hashed.headers.get('cache-control')})`)
  for (const missing of ['/assets/index-gone0000.js', '/assets/gone']) {
    const r = await fetch(base + missing, { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' } })
    await r.arrayBuffer()
    expect(r.status === 404 && !(r.headers.get('content-type') ?? '').includes('text/html'), `${missing} is a 404, not the SPA shell (${r.status} ${r.headers.get('content-type')})`)
  }
  const headersFile = await fetch(`${base}/_headers`)
  expect(!(await headersFile.text()).includes('Cache-Control:'), 'the _headers file is not served')
}
