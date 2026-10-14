import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['tests/main/**/*.test.ts'],
          environment: 'node',
          pool: 'forks',
          testTimeout: 30000
        }
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          include: ['tests/renderer/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/renderer/setup.ts']
        }
      }
    ]
  }
})
