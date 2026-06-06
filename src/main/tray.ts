import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import type { TrayState } from '@shared/types'

let tray: Tray | null = null
let logoImage: Electron.NativeImage | null = null
let currentState: TrayState = 'idle'

// Design token colors matching the widget CSS
const STATE_COLORS: Record<TrayState, string> = {
  'idle': '#c49a2a',           // gold — matches existing logo fill
  'has-something': '#4ade9e',  // --green: suggestions ready / silent action done
  'needs-you': '#6d6aff'       // --accent: explicit approval required
}

function getLogoImage(): Electron.NativeImage {
  if (!logoImage) {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '..', '..', 'resources', 'icon.png')
    try {
      logoImage = nativeImage.createFromBuffer(readFileSync(iconPath)).resize({ width: 22, height: 22 })
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22">
        <rect x="1" y="1" width="20" height="20" rx="5" fill="#c49a2a"/>
      </svg>`
      logoImage = nativeImage.createFromDataURL(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      )
    }
  }
  return logoImage
}

function createStateIcon(state: TrayState): Electron.NativeImage {
  if (state === 'idle') return getLogoImage()
  const size = 22
  const color = STATE_COLORS[state]
  // Filled disc with a subtle rounded-rect background — matches .routine-card__dot vocabulary
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect x="1" y="1" width="20" height="20" rx="5" fill="${color}" opacity="0.18"/>
      <circle cx="11" cy="11" r="5" fill="${color}"/>
     </svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

/** @deprecated Use setTrayState for ambient-aware state. Kept for back-compat with routines/plan badge updates. */
function createTrayIcon(badge: number): Electron.NativeImage {
  if (badge === 0) return getLogoImage()
  const size = 22
  const gold = '#c49a2a'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect x="1" y="1" width="20" height="20" rx="5" fill="${gold}"/>
      <text x="11" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#0d0b08" font-family="system-ui">${badge > 9 ? '9+' : badge}</text>
     </svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

export function createTray(
  toggleWidget: () => void,
  openMainWindow: () => void,
  quit: () => void
): Tray {
  const icon = createStateIcon('idle')
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
 * Called by the ambient service whenever intent state changes.
 */
export function setTrayState(state: TrayState): void {
  if (!tray) return
  currentState = state
  tray.setImage(createStateIcon(state))

  const tooltip =
    state === 'needs-you' ? 'mypa — needs your approval'
    : state === 'has-something' ? 'mypa — updates ready'
    : 'mypa'
  tray.setToolTip(tooltip)

  if (process.platform === 'darwin') {
    // '!' for needs-you, '' for everything else — a dot not a count
    app.dock?.setBadge(state === 'needs-you' ? '!' : '')
  }
}

export function getTrayState(): TrayState {
  return currentState
}

/**
 * @deprecated Kept for back-compat. Routes through setTrayState so both systems
 * stay in sync — badge > 0 maps to 'has-something' only if ambient is currently idle.
 */
export function updateTrayBadge(badge: number): void {
  if (!tray) return
  if (currentState !== 'idle') {
    // Ambient state takes priority; still update the legacy number icon as fallback
    // only when no ambient state is set
    return
  }
  tray.setImage(createTrayIcon(badge))
  if (process.platform === 'darwin') {
    app.dock?.setBadge(badge > 0 ? String(badge) : '')
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
