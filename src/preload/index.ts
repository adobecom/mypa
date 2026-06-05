import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi } from '../shared/types'

const api: IpcApi = {
  plan: {
    createDraft: (intent) => ipcRenderer.invoke('plan:create-draft', intent),
    confirm: (draft) => ipcRenderer.invoke('plan:confirm', draft),
    getAll: () => ipcRenderer.invoke('plan:get-all'),
    updateStatus: (id, status) => ipcRenderer.invoke('plan:update-status', id, status),
    delete: (id) => ipcRenderer.invoke('plan:delete', id),
    sendMessage: (itemId, message) => ipcRenderer.invoke('plan:send-message', itemId, message),
    getThread: (itemId) => ipcRenderer.invoke('plan:get-thread', itemId),
    cancelStream: (itemId) => ipcRenderer.invoke('plan:cancel-stream', itemId)
  },
  routines: {
    getAll: () => ipcRenderer.invoke('routines:get-all'),
    create: (data) => ipcRenderer.invoke('routines:create', data),
    update: (id, data) => ipcRenderer.invoke('routines:update', id, data),
    delete: (id) => ipcRenderer.invoke('routines:delete', id),
    runNow: (id) => ipcRenderer.invoke('routines:run-now', id),
    getRuns: (routineId, limit) => ipcRenderer.invoke('routines:get-runs', routineId, limit),
    getAllRuns: (limit) => ipcRenderer.invoke('routines:get-all-runs', limit),
    getThread: (runId) => ipcRenderer.invoke('routines:get-thread', runId),
    sendMessage: (runId, message) => ipcRenderer.invoke('routines:send-message', runId, message),
    updateRunStatus: (runId, status) => ipcRenderer.invoke('routines:update-run-status', runId, status),
    generateSetup: (intent) => ipcRenderer.invoke('routines:generate-setup', intent),
    cancelStream: (runId) => ipcRenderer.invoke('routines:cancel-stream', runId)
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    update: (config) => ipcRenderer.invoke('config:update', config),
    testMcpServer: (cfg) => ipcRenderer.invoke('config:test-mcp-server', cfg),
    getMcpStatus: () => ipcRenderer.invoke('config:get-mcp-status')
  },
  oauth: {
    startDevice: () => ipcRenderer.invoke('oauth:start-device'),
    pollDevice: (deviceCode: string) => ipcRenderer.invoke('oauth:poll-device', deviceCode),
    startPkce: (provider: 'notion' | 'linear') => ipcRenderer.invoke('oauth:start-pkce', provider)
  },
  setup: {
    checkPrerequisites: () => ipcRenderer.invoke('setup:check-prerequisites'),
    getHealth: () => ipcRenderer.invoke('setup:get-health')
  },
  system: {
    openMainWindow: (routineId?: string) => ipcRenderer.invoke('system:open-main-window', routineId),
    getBadgeCount: () => ipcRenderer.invoke('system:get-badge-count'),
    getWindowType: () => {
      // Determined by the HTML file loaded
      return window.location.pathname.includes('widget') ? 'widget' : 'main-window'
    }
  },
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('electron', api)

// Type augmentation for the renderer
declare global {
  interface Window {
    electron: IpcApi
  }
}
