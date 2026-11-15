import path from 'node:path'
import { serve } from '@hono/node-server'
import { parseConfig } from './core/config.ts'
import { createNodeApp, nodeAssets } from './platform-node.ts'

const config = parseConfig(process.env)
const app = await createNodeApp({ config, assets: nodeAssets(path.resolve(process.env.WEB_DIR || 'web/dist')) })

const server = serve({ fetch: (request) => app.edge.fetch(request), port: config.port, hostname: config.host }, (info) => {
  console.log(`MailCorgi is running at http://localhost:${info.port}${config.appUrl ? ` (public URL: ${config.appUrl})` : ''}`)
})
app.startScheduler()

const shutdown = () => {
  console.log('Shutting down…')
  app.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err) => console.error('[unhandled]', err))
process.on('uncaughtException', (err) => console.error('[uncaught]', err))
