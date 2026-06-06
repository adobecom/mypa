import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import type { TrayState } from '@shared/types'

let tray: Tray | null = null
let logoImage: Electron.NativeImage | null = null
let badgedLogoImage: Electron.NativeImage | null = null
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

/**
 * Paint a red dot in the top-right corner of a 22×22pt tray icon, producing
 * a badged variant for the "needs-you" attention state.
 *
 * macOS Tray has no native badge API, so we composite the dot by manipulating
 * the raw BGRA bitmap for both the 1× and 2× Retina representations.
 */
function getBadgedLogoImage(): Electron.NativeImage {
  if (badgedLogoImage) return badgedLogoImage

  // Paint a filled red circle into a raw BGRA pixel buffer.
  // cx/cy are the circle centre in pixels; r is the radius.
  function paintDot(buf: Buffer, w: number, h: number, cx: number, cy: number, r: number): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= r * r) {
          const idx = (y * w + x) * 4
          buf[idx]     = 50   // B
          buf[idx + 1] = 50   // G
          buf[idx + 2] = 220  // R  → vivid red in BGRA
          buf[idx + 3] = 255  // A  → fully opaque
        }
      }
    }
  }

  try {
    const src = nativeImage.createFromBuffer(readFileSync(resolveIconPath()))

    // 1× representation: 22×22 px
    const size1x = 22
    const buf1x  = src.resize({ width: size1x, height: size1x, quality: 'best' }).toBitmap()
    const r1     = 3   // dot radius in px
    paintDot(buf1x, size1x, size1x, size1x - r1 - 1, r1 + 1, r1)

    // 2× representation: 44×44 px (Retina)
    const size2x = 44
    const buf2x  = src.resize({ width: size2x, height: size2x, quality: 'best' }).toBitmap()
    const r2     = 6   // dot radius in px (2× of r1)
    paintDot(buf2x, size2x, size2x, size2x - r2 - 2, r2 + 2, r2)

    // Assemble the multi-rep NativeImage
    const img = nativeImage.createFromBitmap(buf1x, { width: size1x, height: size1x, scaleFactor: 1 })
    img.addRepresentation({
      scaleFactor: 2,
      width: size2x,
      height: size2x,
      buffer: nativeImage.createFromBitmap(buf2x, { width: size2x, height: size2x, scaleFactor: 2 }).toPNG()
    })

    badgedLogoImage = img
  } catch (err) {
    console.error('[tray] failed to build badged icon:', err)
    badgedLogoImage = getLogoImage() // fall back to plain icon
  }

  return badgedLogoImage!
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
 * State is conveyed via tooltip text and, for "needs-you", a red dot composited
 * onto the menu-bar tray icon image. The dock icon is left without a badge so the
 * user always looks to the tray — the place they interact with mypa.
 */
export function setTrayState(state: TrayState): void {
  if (!tray) return
  currentState = state

  const tooltip =
    state === 'needs-you' ? 'mypa — needs your approval'
    : state === 'has-something' ? 'mypa — updates ready'
    : 'mypa'
  tray.setToolTip(tooltip)

  // Show a red dot on the tray icon when attention is required, clear it otherwise.
  tray.setImage(state === 'needs-you' ? getBadgedLogoImage() : getLogoImage())
}

export function getTrayState(): TrayState {
  return currentState
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
