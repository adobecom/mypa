import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { readConfig } from './services/config'

const WIDGET_WIDTH = 440
const WIDGET_HEIGHT = 580

let widgetWin: BrowserWindow | null = null
let mainWin: BrowserWindow | null = null
let isQuitting = false

export function setQuitting(): void {
  isQuitting = true
}

export function createWidgetWindow(): BrowserWindow {
  const cfg = readConfig()

  widgetWin = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    resizable: false,
    frame: false,
    transparent: true,
    ...(process.platform === 'darwin' && { vibrancy: 'sidebar' as const }),
    alwaysOnTop: cfg.preferences.widget_always_on_top,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  widgetWin.setTitle('mypa-widget')
  attachExternalLinkGuards(widgetWin)

  if (process.env['ELECTRON_RENDERER_URL']) {
    widgetWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/widget.html`)
  } else {
    widgetWin.loadFile(join(__dirname, '../renderer/widget.html'))
  }

  // Hide instead of close when user closes
  widgetWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      widgetWin?.hide()
    }
  })

  widgetWin.on('blur', () => {
    // Hide on blur unless devtools open
    if (widgetWin?.webContents.isDevToolsOpened()) return
    // Uncomment to auto-hide on blur:
    // widgetWin?.hide()
  })

  return widgetWin
}

export function createMainWindow(): BrowserWindow {
  mainWin = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 760,
    minHeight: 500,
    frame: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0c14',
    transparent: process.platform === 'darwin',
    ...(process.platform === 'darwin' && { vibrancy: 'under-window' as const }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWin.setTitle('mypa')
  attachExternalLinkGuards(mainWin)

  const loadMain = (): void => {
    if (process.env['ELECTRON_RENDERER_URL']) {
      mainWin?.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/main-window.html`)
    } else {
      mainWin?.loadFile(join(__dirname, '../renderer/main-window.html'))
    }
  }

  // In dev mode, Vite may still be compiling the widget entry when the main window
  // is created (activate fires at launch). Delay the first load to avoid hitting
  // Vite during its cold-start burst, which causes ERR_EMPTY_RESPONSE → crash.
  if (process.env['ELECTRON_RENDERER_URL']) {
    setTimeout(loadMain, 2000)
  } else {
    loadMain()
  }

  mainWin.webContents.on('did-fail-load', (_e, _code, _desc, url) => {
    if (url.includes('main-window')) setTimeout(loadMain, 1500)
  })

  mainWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWin?.hide()
    }
  })

  mainWin.on('closed', () => {
    mainWin = null
  })

  return mainWin
}

export function toggleWidget(): void {
  if (!widgetWin) return

  if (widgetWin.isVisible()) {
    widgetWin.hide()
    return
  }

  positionWidgetNearTray()
  widgetWin.show()
  widgetWin.focus()
}

function positionWidgetNearTray(): void {
  if (!widgetWin) return
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.workAreaSize
  const bounds = display.workArea

  // Position bottom-right near the tray area
  const x = bounds.x + width - WIDGET_WIDTH - 12
  const y = bounds.y + height - WIDGET_HEIGHT - 12

  widgetWin.setPosition(x, y)
}

export function getWidgetWindow(): BrowserWindow | null {
  return widgetWin
}

export function getMainWindow(): BrowserWindow | null {
  return mainWin
}

function attachExternalLinkGuards(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
  win.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

/**
 * Send an IPC event to every open, non-destroyed window (widget + main).
 * Callers targeting a specific window should continue using the direct getter.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of [widgetWin, mainWin]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

export function openOrFocusMainWindow(): BrowserWindow {
  if (mainWin) {
    mainWin.show()
    mainWin.focus()
    return mainWin
  }
  return createMainWindow()
}
