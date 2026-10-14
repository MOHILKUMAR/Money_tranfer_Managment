import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { buildContentSecurityPolicy } from './src/shared/csp'

/**
 * Injects the Content-Security-Policy meta tag. Development needs a relaxed
 * policy for Vite's HMR client and React refresh preamble; production builds
 * get the strict policy (also sent as a response header by the app:// protocol).
 */
function cspPlugin(): Plugin {
  let isDev = false
  return {
    name: 'cmm-csp',
    configResolved(config) {
      isDev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const policy = buildContentSecurityPolicy(isDev ? 'development' : 'production')
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
      )
    }
  }
}

const sharedAlias = { '@shared': resolve(import.meta.dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: {
      alias: { ...sharedAlias, '@': resolve(import.meta.dirname, 'src/renderer/src') }
    },
    plugins: [react(), tailwindcss(), cspPlugin()],
    build: {
      minify: true,
      chunkSizeWarningLimit: 4096,
      rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') }
    }
  }
})
