import { existsSync } from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { setUpdateReady } from '../tray'

type GetWindow = () => BrowserWindow | null

function pushToAllWindows(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  })
}

// electron-updater reads this from Contents/Resources in packaged builds; it's only written
// when a build produces the mac zip/dmg (or win nsis / linux AppImage) target — a `--dir`
// build (e.g. the `unpack` skill's `npm run pack`) never has it.
function hasUpdateConfig(): boolean {
  return existsSync(path.join(process.resourcesPath, 'app-update.yml'))
}

export function initUpdater(_getWindow: GetWindow): void {
  // Only run in packaged builds — electron-updater errors in dev without a feed
  if (!app.isPackaged) return

  if (!hasUpdateConfig()) {
    console.log('[updater] no app-update.yml — build cannot self-update (likely a local pack/--dir install)')
    return
  }

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
  if (!hasUpdateConfig()) {
    pushToAllWindows(
      'update:error',
      "This build can't check for updates — it wasn't installed from a signed release."
    )
    return
  }
  autoUpdater.checkForUpdates().catch(() => {})
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
