import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import type { TrayState } from '@shared/types'

let tray: Tray | null = null
let logoImage: Electron.NativeImage | null = null
let currentState: TrayState = 'idle'

/** Resolve the tray icon PNG path in both dev and packaged mode. */
export function resolveIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '..', '..', 'resources', 'icon.png')
}

function getLogoImage(): Electron.NativeImage {
  if (!logoImage) {
    try {
      const src = nativeImage.createFromBuffer(readFileSync(resolveIconPath()))
      // Build a 1x rep at 22pt and add a 2x rep for Retina menu bars
      const img = src.resize({ width: 22, height: 22, quality: 'best' })
      img.addRepresentation({
        scaleFactor: 2,
        width: 22,
        height: 22,
        buffer: src.resize({ width: 44, height: 44, quality: 'best' }).toPNG()
      })
      logoImage = img
    } catch (err) {
      console.error('[tray] failed to load icon:', err)
      logoImage = nativeImage.createEmpty()
    }
  }
  return logoImage
}

export function createTray(
  toggleWidget: () => void,
  openMainWindow: () => void,
  quit: () => void
): Tray {
  const icon = getLogoImage()
  tray = new Tray(icon)
  tray.setToolTip('mypa')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open mypa', click: openMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: quit }
  ])

  tray.on('click', toggleWidget)
  tray.on('right-click', () => {
    tray?.popUpContextMenu(contextMenu)
  })

  return tray
}

/**
 * Set the three-state tray icon for ambient intelligence.
 * The menu-bar icon is always the logo PNG; state is conveyed via tooltip and dock badge.
 */
export function setTrayState(state: TrayState): void {
  if (!tray) return
  currentState = state

  const tooltip =
    state === 'needs-you' ? 'mypa — needs your approval'
    : state === 'has-something' ? 'mypa — updates ready'
    : 'mypa'
  tray.setToolTip(tooltip)

  if (process.platform === 'darwin') {
    app.dock?.setBadge(state === 'needs-you' ? '!' : '')
  }
}

export function getTrayState(): TrayState {
  return currentState
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
