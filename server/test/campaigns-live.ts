import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const freePort = () => new Promise<number>((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address()
    if (!address || typeof address === 'string') { socket.close(); reject(new Error('No port')); return }
    socket.close(() => resolve(address.port))
  })
})
const worker = process.argv.includes('--worker')
const apiPort = await freePort()
const inspectorPort = await freePort()
const webPort = await freePort()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcorgi-campaigns-live-'))
const base = `http://127.0.0.1:${worker ? apiPort : webPort}`
const children: ChildProcess[] = []
let diagnostic = ''
function start(args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort), DATA_DIR: dataDir, APP_URL: base }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000) })
  children.push(child)
}
async function ready(url: string) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (children.some((child) => child.exitCode !== null)) throw new Error(diagnostic)
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Server did not start: ${diagnostic}`)
}
const jar: Record<string, string> = {}
let csrf = ''
async function call(route: string, body?: unknown) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json', 'x-mc-csrf': csrf }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const i = pair.indexOf('='); jar[pair.slice(0, i)] = pair.slice(i + 1) }
  assert.equal(response.status, 200, route)
  return response.json()
}
try {
  if (worker) start(['node_modules/wrangler/bin/wrangler.js', 'dev', '--ip', '127.0.0.1', '--port', String(apiPort), '--inspector-port', String(inspectorPort), '--persist-to', dataDir, '--var', `APP_URL:${base}`, '--show-interactive-dev-session=false', '--log-level', 'warn'])
  else {
    start(['--import', 'tsx', 'server/index.ts'])
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort'])
  }
  await ready(`http://127.0.0.1:${apiPort}/healthz`)
  await ready(base)
  await call('/api/auth/setup', { name: 'Test User', email: 'live@example.com', password: 'a test password only' })
  csrf = (await call('/api/auth/bootstrap')).session.csrf
  const action = (name: string, input: unknown) => call(`/api/actions/${name}`, input)
  const nl = await action('newsletters.create', { name: 'Live Weekly' })
  const campaign = await action('campaigns.create', { newsletterId: nl.id, subject: 'Live issue' })
  for (const page of ['/campaigns', `/campaigns/${campaign.id}`, '/settings/design']) {
    const html = execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', `${base}${page}`], { encoding: 'utf8' })
    assert.ok(html.includes('id="root"'))
    console.log(`live: ${page} SPA ok`)
  }
  const list = await action('campaigns.list', { newsletterId: nl.id })
  assert.equal(list.total, 1)
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live content' }] }] }
  const updated = await action('campaigns.update', { campaignId: campaign.id, revision: campaign.revision, doc, previewText: 'Live preview' })
  assert.deepEqual((await action('campaigns.get', { campaignId: campaign.id })).doc, doc)
  assert.equal(updated.revision, 2)
  const preview = await action('campaigns.preview', { campaignId: campaign.id })
  assert.ok(preview.email.html.includes('Live content'))
  assert.ok(preview.web.html.includes('Live content'))
  await action('campaigns.audienceOptions', { newsletterId: nl.id })
  const design = await action('campaigns.getTheme', { newsletterId: nl.id })
  const sample = await action('campaigns.previewDesign', { newsletterId: nl.id, theme: design.theme })
  assert.ok(sample.email.html.includes('A thoughtful story'))
  await action('campaigns.updateTheme', { newsletterId: nl.id, theme: design.theme })
  const image = await action('campaigns.uploadImage', { newsletterId: nl.id, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC', width: 1, height: 1 })
  assert.equal((await fetch(image.url)).headers.get('content-type'), 'image/png')
  const htmlIssue = await action('campaigns.create', { newsletterId: nl.id, format: 'html', subject: 'HTML issue', html: '<p style="color:red">Hello</p><script>alert(1)</script>' })
  const htmlPreview = await action('campaigns.preview', { campaignId: htmlIssue.id })
  assert.ok(!htmlPreview.web.html.includes('<script>'))
  assert.ok(htmlPreview.email.html.includes('<p style="color:red">Hello</p>'))
  const markdownIssue = await action('campaigns.create', { newsletterId: nl.id, format: 'markdown', subject: 'Markdown issue', source: '## Heading\n\nA **strong** idea.' })
  const markdownPreview = await action('campaigns.preview', { campaignId: markdownIssue.id })
  assert.ok(markdownPreview.email.html.includes('<strong>strong</strong>'))
  if (!worker) for (const module of ['/src/features/campaigns/Editor.tsx', '/src/features/design/index.tsx']) assert.equal((await fetch(base + module)).status, 200)
  console.log(`live: ${worker ? 'Worker' : 'Node'} list, editor save/reload, audience, all render formats, image upload and design actions ok`)
} finally {
  for (const child of children) {
    if (child.pid && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      process.kill(-child.pid, 'SIGTERM')
      await exited
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
  console.log('live: dev servers stopped')
}
