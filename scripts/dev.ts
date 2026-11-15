/** Runs the API server and the Vite dev server together. Ctrl-C stops both. */
import { spawn } from 'node:child_process'

const procs = [
  { name: 'api', color: '\x1b[34m', args: ['run', 'dev:server'] },
  { name: 'web', color: '\x1b[35m', args: ['run', 'dev:web'] },
].map(({ name, color, args }) => {
  const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const prefix = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) process.stdout.write(`${color}[${name}]\x1b[0m ${line}\n`)
  }
  child.stdout.on('data', prefix)
  child.stderr.on('data', prefix)
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[${name}] exited with ${code}`)
  })
  return child
})

const stop = () => {
  for (const p of procs) p.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
