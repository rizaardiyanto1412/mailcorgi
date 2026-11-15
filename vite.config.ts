import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = `http://localhost:${process.env.PORT || 3000}`

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      '/f/': { target: apiTarget, changeOrigin: false },
      '/embed.js': { target: apiTarget, changeOrigin: false },
      '/confirm/': { target: apiTarget, changeOrigin: false },
      '/api': { target: apiTarget, changeOrigin: false },
      '^/n(?:/|$)': { target: apiTarget, changeOrigin: false },
      '/mcp': { target: apiTarget, changeOrigin: false },
      '/img': apiTarget,
      '/healthz': apiTarget,
      '/llms.txt': { target: apiTarget, changeOrigin: false },
    },
  },
})
