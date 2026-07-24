import { app, BrowserWindow, nativeImage, dialog } from 'electron'
import { fixPath } from './services/path-fix'
import { handleOAuthCallback } from './services/oauth'
import { readFileSync } from 'fs'
import { initDb, dbRunMaintenance } from './db/index'
import { readConfig, seedScopeIfUnset } from './services/config'
import { connectAllServers, disconnectAllServers, withTimeout } from './services/mcp'
import { startScheduler, stopScheduler } from './services/cron'
import { startAmbient, stopAmbient, ambientComputeTrayState } from './services/ambient'
import { rescanRepos } from './services/repos'
import { registerIpcHandlers } from './ipc-handlers'
import { createTray, setTrayState, setUpdateReady, destroyTray, resolveIconPath } from './tray'
import {
  createWidgetWindow,
  toggleWidget,
  openOrFocusMainWindow,
  getWidgetWindow,
  setQuitting,
  updateBadgeCount
} from './windows'
import { initUpdater, checkForUpdatesNow, installUpdate } from './services/updater'

// Keep app running when all windows closed on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray
  }
})

app.on('activate', () => {
  openOrFocusMainWindow()
})

// Guard against async EPIPE errors emitted on the claude-agent-sdk subprocess's
// stdin stream when the child exits while a write is still queued (e.g. on abort
// or timeout). The SDK attaches no 'error' listener to that private stream, so the
// error would otherwise surface as an Electron uncaught-exception OS dialog.
// All other errors are logged and, in packaged builds, shown as an error dialog
// (parity with the prior Electron default behavior).
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE' || /\bEPIPE\b/.test(err?.message ?? '')) {
    console.warn('[main] ignoring benign EPIPE from subprocess stdin:', err.message)
    return
  }
  console.error('[main] uncaught exception:', err)
  if (app.isPackaged) {
    dialog.showErrorBox('mypa encountered an error', err?.stack ?? String(err))
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

async function main(): Promise<void> {
  // Augment PATH so packaged GUI builds can find claude, npx, etc.
  // Must run before any child-process spawning (MCP, claude CLI, which-checks).
  fixPath()

  await app.whenReady()

  // Register custom protocol for OAuth callbacks
  app.setAsDefaultProtocolClient('mypa')
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleOAuthCallback(url)
  })

  // Single instance lock
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on('second-instance', (_event, argv) => {
    // On Windows, OAuth redirect arrives as a command-line argument
    const url = argv.find((arg) => arg.startsWith('mypa://'))
    if (url) handleOAuthCallback(url)
    openOrFocusMainWindow()
  })

  // Initialize database — wrap so a missing/misbuilt native module shows a
  // clear error dialog instead of crashing silently or half-starting the app.
  try {
    initDb()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox(
      'mypa could not start',
      `The local database failed to initialize:\n\n${msg}\n\n` +
      `If you just installed mypa or updated Node.js, run:\n\n` +
      `  npm run postinstall\n\n` +
      `in the project directory to rebuild native dependencies, then restart the app.`
    )
    app.quit()
    return
  }

  // Seed scope allowlist if this is the first run or config predates scope config
  seedScopeIfUnset()

  // Create widget window (hidden initially)
  const win = createWidgetWindow()

  // Register IPC handlers before tray so renderer can always communicate
  registerIpcHandlers(
    () => getWidgetWindow(),
    openOrFocusMainWindow
  )

  // Single cleanup path shared by the tray "Quit" action and the OS-initiated
  // quit (Cmd+Q, dock quit, shutdown). Awaits MCP disconnect (bounded by a
  // timeout so a hung stdio server can't block quitting) before the process
  // actually exits, so child processes aren't orphaned. `cleanupStarted`
  // guards against *starting* cleanup twice — it must NOT gate
  // preventDefault(), which has to run on every 'before-quit' while cleanup
  // is still in flight, or a second quit trigger (e.g. Cmd+Q right after
  // clicking tray Quit) would let Electron's default quit proceed
  // concurrently with — and possibly before — the in-progress cleanup.
  let cleanupStarted = false
  async function cleanupAndExit(): Promise<void> {
    if (cleanupStarted) return
    cleanupStarted = true
    setQuitting()
    stopScheduler()
    stopAmbient()
    try {
      await withTimeout(disconnectAllServers(), 3_000, 'disconnectAllServers on quit')
    } catch (err) {
      console.error('[main] error disconnecting MCP servers during quit:', err)
    }
    destroyTray()
    app.exit(0)
  }

  app.on('before-quit', (event) => {
    event.preventDefault()
    cleanupAndExit()
  })

  // Create tray
  createTray(
    () => toggleWidget(),
    () => openOrFocusMainWindow(),
    () => app.quit(),
    () => checkForUpdatesNow(),
    () => installUpdate()
  )

  // Initialize auto-updater (no-op in dev mode)
  initUpdater(() => getWidgetWindow())

  // Connect MCP servers
  connectAllServers().catch((err) => console.error('[mcp] startup error:', err))

  // Start cron scheduler
  startScheduler(() => getWidgetWindow())

  // Start ambient intelligence (fire-and-forget, same as connectAllServers)
  startAmbient(() => getWidgetWindow())

  // Scan configured code roots for local git checkouts (fire-and-forget, same as above)
  rescanRepos().catch((err) => console.error('[repos] startup scan failed:', err))

  // Periodic DB maintenance — prune old signals, action log, and decayed graph nodes.
  // Run once at startup (after a short delay) and then every 24 hours.
  setTimeout(() => {
    dbRunMaintenance()
    setInterval(() => dbRunMaintenance(), 24 * 60 * 60 * 1000)
  }, 60_000)

  // Set initial tray state and Dock badge
  setTrayState(ambientComputeTrayState())
  updateBadgeCount()

  win.show()

  // Set dock icon on macOS — after win.show() so the dock entry exists
  if (process.platform === 'darwin') {
    try {
      const data = readFileSync(resolveIconPath())
      const icon = nativeImage.createFromBuffer(data)
      if (!icon.isEmpty()) app.dock?.setIcon(icon)
    } catch (_) {
      // leave default
    }
  }
}

main().catch(console.error)
