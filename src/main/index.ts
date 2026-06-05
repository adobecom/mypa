import { app, BrowserWindow, nativeImage } from 'electron'
import { handleOAuthCallback } from './services/oauth'
import { join } from 'path'
import { readFileSync } from 'fs'
import { initDb, dbGetBadgeCount } from './db/index'
import { readConfig } from './services/config'
import { connectAllServers, disconnectAllServers } from './services/mcp'
import { startScheduler, stopScheduler } from './services/cron'
import { registerIpcHandlers } from './ipc-handlers'
import { createTray, updateTrayBadge, destroyTray } from './tray'
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
      disconnectAllServers()
      destroyTray()
      app.exit(0)
    }
  )

  // Connect MCP servers
  connectAllServers().catch((err) => console.error('[mcp] startup error:', err))

  // Start cron scheduler
  startScheduler(() => getWidgetWindow())

  // Update badge on start
  updateTrayBadge(dbGetBadgeCount())

  // Prevent app from quitting when last window closes — stay in tray
  app.on('before-quit', () => {
    setQuitting()
    stopScheduler()
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
