import { resolve } from 'path'
import { execSync } from 'child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const gitSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'unknown' }
})()

// eslint-disable-next-line @typescript-eslint/no-var-requires
const appVersion = require('./package.json').version as string

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@anthropic-ai/claude-agent-sdk'] })],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_GIT_SHA': JSON.stringify(gitSha)
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: {
          widget: resolve(__dirname, 'src/renderer/widget.html'),
          'main-window': resolve(__dirname, 'src/renderer/main-window.html')
        }
      }
    }
  }
})
