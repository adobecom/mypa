import { app, BrowserWindow, nativeImage } from 'electron'
import { handleOAuthCallback } from './services/oauth'
import { join } from 'path'
import { readFileSync } from 'fs'
import { initDb, dbGetBadgeCount, dbRunMaintenance } from './db/index'
import { readConfig } from './services/config'
import { connectAllServers, disconnectAllServers } from './services/mcp'
import { startScheduler, stopScheduler } from './services/cron'
import { startAmbient, stopAmbient, ambientComputeTrayState } from './services/ambient'
import { registerIpcHandlers } from './ipc-handlers'
import { createTray, updateTrayBadge, setTrayState, destroyTray } from './tray'
import {
  createWidgetWindow,
  toggleWidget,
  openOrFocusMainWindow,
  getWidgetWindow,
  setQuitting
} from './windows'

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

  // Initialize database
  initDb()

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
    }
  )

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

  // Update tray with initial state
  updateTrayBadge(dbGetBadgeCount())
  setTrayState(ambientComputeTrayState())

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
      const iconPath = app.isPackaged
        ? join(process.resourcesPath, 'icon.png')
        : join(__dirname, '..', '..', 'resources', 'icon.png')
      const data = readFileSync(iconPath)
      const icon = nativeImage.createFromDataURL(`data:image/png;base64,${data.toString('base64')}`)
      if (!icon.isEmpty()) app.dock?.setIcon(icon)
    } catch (_) {
      // leave default
    }
  }
}

main().catch(console.error)
