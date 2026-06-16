import { app, BrowserWindow, nativeImage, dialog } from 'electron'
import { fixPath } from './services/path-fix'
import { handleOAuthCallback } from './services/oauth'
import { readFileSync } from 'fs'
import { initDb, dbRunMaintenance } from './db/index'
import { readConfig } from './services/config'
import { connectAllServers, disconnectAllServers } from './services/mcp'
import { startScheduler, stopScheduler } from './services/cron'
import { startAmbient, stopAmbient, ambientComputeTrayState } from './services/ambient'
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

  // Create widget window (hidden initially)
  const win = createWidgetWindow()

  // Register IPC handlers before tray so renderer can always communicate
  registerIpcHandlers(
    () => getWidgetWindow(),
    openOrFocusMainWindow
  )

  // Create tray
  createTray(
    () => toggleWidget(),
    () => openOrFocusMainWindow(),
    () => {
      setQuitting()
      stopScheduler()
      stopAmbient()
      disconnectAllServers()
      destroyTray()
      app.exit(0)
    },
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

  // Periodic DB maintenance — prune old signals, action log, and decayed graph nodes.
  // Run once at startup (after a short delay) and then every 24 hours.
  setTimeout(() => {
    dbRunMaintenance()
    setInterval(() => dbRunMaintenance(), 24 * 60 * 60 * 1000)
  }, 60_000)

  // Set initial tray state and Dock badge
  setTrayState(ambientComputeTrayState())
  updateBadgeCount()

  // Prevent app from quitting when last window closes — stay in tray
  app.on('before-quit', () => {
    setQuitting()
    stopScheduler()
    stopAmbient()
    disconnectAllServers()
    destroyTray()
  })

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
