import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { setUpdateReady } from '../tray'

type GetWindow = () => BrowserWindow | null

function pushToAllWindows(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  })
}

export function initUpdater(_getWindow: GetWindow): void {
  // Only run in packaged builds — electron-updater errors in dev without a feed
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    pushToAllWindows('update:available', { version: info.version, releaseNotes: info.releaseNotes })
  })

  autoUpdater.on('download-progress', (progress) => {
    pushToAllWindows('update:progress', { percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', () => {
    setUpdateReady(true)
    pushToAllWindows('update:downloaded')
  })

  autoUpdater.on('error', (err) => {
    pushToAllWindows('update:error', err.message)
  })

  // First check 30 s after startup, then every 4 hours
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
  }, 30_000)
}

export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch(() => {})
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
