/**
 * Drives a running instance over HTTP: first-run setup, sign in, create a newsletter, read it
 * back, /healthz. With --url it targets that instance; without, it starts the Node build and a
 * `wrangler dev` Worker in turn on random free ports and runs against each.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createSmokeContext } from './smoke-context.ts'

const root = path.resolve(import.meta.dirname, '..')
const argUrl = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : null

async function scenario(base: string) {
  const context = createSmokeContext(base)
  const directory = new URL('./smoke/', import.meta.url)
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.ts')).sort()
  for (const file of files) {
    const { default: step } = await import(new URL(file, directory).href)
    if (typeof step !== 'function') throw new Error(`smoke: ${file} must export a default async function`)
    await step(context)
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

async function waitFor(url: string, child: ChildProcess, ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`smoke: the server exited with ${child.exitCode} before it was ready`)
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`smoke: ${url} did not come up within ${ms} ms`)
}

function start(cmd: string, args: string[], env: Record<string, string>, label: string): ChildProcess {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const log = (chunk: Buffer) => {
    if (process.env.SMOKE_VERBOSE) for (const line of chunk.toString().split('\n')) if (line.trim()) console.log(`[${label}] ${line}`)
  }
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)
  return child
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 3000).unref()
}

async function runNode() {
  if (!fs.existsSync(path.join(root, 'dist/index.js')) || !fs.existsSync(path.join(root, 'web/dist/index.html'))) throw new Error('smoke: run "npm run build" first')
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-smoke-node-'))
  const base = `http://127.0.0.1:${port}`
  const child = start('node', ['--disable-warning=ExperimentalWarning', 'dist/index.js'], { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_URL: base }, 'node')
  try {
    await waitFor(`${base}/healthz`, child, 20_000)
    await scenario(base)
    console.log(`smoke: node ok (${base})`)
  } finally {
    stop(child)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

async function runDev() {
  const port = await freePort()
  const webPort = await freePort()
  const dataDir = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-smoke-dev-'))
  const base = `http://127.0.0.1:${webPort}`
  const api = start('npx', ['tsx', 'server/index.ts'], { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_URL: base }, 'dev-api')
  const web = start('npx', ['vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { PORT: String(port), WEB_PORT: String(webPort) }, 'dev-web')
  try {
    await waitFor(`${base}/healthz`, web, 20_000)
    await scenario(base)
    console.log(`smoke: Vite dev pages and actions ok (${base})`)
  } finally {
    stop(web)
    stop(api)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

async function runWrangler() {
  const port = await freePort()
  const inspector = await freePort()
  const persist = fs.mkdtempSync(path.join(root, '.audit', 'mailcorgi-smoke-cf-'))
  const base = `http://127.0.0.1:${port}`
  const child = start(
    'npx',
    ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', persist, '--var', `APP_URL:${base}`, '--show-interactive-dev-session=false', '--log-level', 'warn'],
    { CI: '1', WRANGLER_SEND_METRICS: 'false' },
    'wrangler',
  )
  try {
    await waitFor(`${base}/healthz`, child, 90_000)
    await scenario(base)
    console.log(`smoke: wrangler dev ok (${base})`)
  } finally {
    stop(child)
    fs.rmSync(persist, { recursive: true, force: true })
  }
}

fs.mkdirSync(path.join(root, '.audit'), { recursive: true })

try {
  if (argUrl) {
    await scenario(argUrl)
    console.log(`smoke: ok (${argUrl})`)
  } else if (process.argv.includes('--dev')) {
    await runDev()
  } else {
    await runNode()
    await runWrangler()
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
}
