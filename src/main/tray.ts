import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'

let tray: Tray | null = null
let logoImage: Electron.NativeImage | null = null

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
  const icon = createTrayIcon(0)
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

export function updateTrayBadge(badge: number): void {
  if (!tray) return
  tray.setImage(createTrayIcon(badge))

  // macOS dock badge
  if (process.platform === 'darwin') {
    app.dock?.setBadge(badge > 0 ? String(badge) : '')
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
