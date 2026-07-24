import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Mirrors the @shared alias from electron.vite.config.ts (main/preload/renderer configs)
// and adds a test-only @main alias — main-process modules have no alias in production
// since they only ever import each other via relative paths.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**', 'src/shared/**']
    }
  }
})
