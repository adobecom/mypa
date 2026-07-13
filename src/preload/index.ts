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
    cancelStream: (itemId) => ipcRenderer.invoke('plan:cancel-stream', itemId),
    getItem: (itemId) => ipcRenderer.invoke('plan:get-item', itemId),
    openInMainWindow: (itemId) => ipcRenderer.invoke('plan:open-in-main-window', itemId),
    approveChatAction: (itemId, messageId, editedPayload) =>
      ipcRenderer.invoke('plan:approve-chat-action', itemId, messageId, editedPayload),
    dismissChatAction: (itemId, messageId) =>
      ipcRenderer.invoke('plan:dismiss-chat-action', itemId, messageId)
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
    cancelStream: (runId) => ipcRenderer.invoke('routines:cancel-stream', runId),
    openRunInMainWindow: (runId) => ipcRenderer.invoke('routines:open-run-in-main-window', runId)
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    update: (config) => ipcRenderer.invoke('config:update', config),
    reconnectMcpServer: (name) => ipcRenderer.invoke('config:reconnect-mcp-server', name),
    reconnectAll: () => ipcRenderer.invoke('config:reconnect-all'),
    getMcpStatus: () => ipcRenderer.invoke('config:get-mcp-status'),
    getClaudeKey: () => ipcRenderer.invoke('config:get-claude-key'),
    setClaudeKey: (key) => ipcRenderer.invoke('config:set-claude-key', key),
    getScopeCandidates: () => ipcRenderer.invoke('config:get-scope-candidates')
  },
  repos: {
    getAll: () => ipcRenderer.invoke('repos:get-all'),
    add: (localPath, jiraProjectKeys) => ipcRenderer.invoke('repos:add', localPath, jiraProjectKeys),
    update: (id, update) => ipcRenderer.invoke('repos:update', id, update),
    remove: (id) => ipcRenderer.invoke('repos:remove', id)
  },
  oauth: {
    startDevice: () => ipcRenderer.invoke('oauth:start-device'),
    pollDevice: (deviceCode: string) => ipcRenderer.invoke('oauth:poll-device', deviceCode),
    startPkce: (provider: 'notion' | 'linear') => ipcRenderer.invoke('oauth:start-pkce', provider)
  },
  setup: {
    checkPrerequisites: () => ipcRenderer.invoke('setup:check-prerequisites'),
    getHealth: () => ipcRenderer.invoke('setup:get-health'),
    detectClaudeMcp: () => ipcRenderer.invoke('setup:detect-claude-mcp'),
    resolveOwnerHandles: () => ipcRenderer.invoke('setup:resolve-owner-handles')
  },
  system: {
    openMainWindow: (routineId?: string) => ipcRenderer.invoke('system:open-main-window', routineId),
    getBadgeCount: () => ipcRenderer.invoke('system:get-badge-count'),
    getWindowType: () => {
      // Determined by the HTML file loaded
      return window.location.pathname.includes('widget') ? 'widget' : 'main-window'
    },
    openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url),
    factoryReset: () => ipcRenderer.invoke('system:factory-reset'),
    pickDirectory: (multiple?: boolean) => ipcRenderer.invoke('system:pick-directory', multiple)
  },
  knowledge: {
    listVaultFolders: (path: string) => ipcRenderer.invoke('knowledge:list-vault-folders', path)
  },
  ambient: {
    getIntents: () => ipcRenderer.invoke('ambient:get-intents'),
    getAllIntents: (limit?: number) => ipcRenderer.invoke('ambient:get-all-intents', limit),
    approve: (id: string, payload?: Record<string, unknown>) => ipcRenderer.invoke('ambient:approve', id, payload),
    dismiss: (id: string) => ipcRenderer.invoke('ambient:dismiss', id),
    challenge: (id: string, reason: string) => ipcRenderer.invoke('ambient:challenge', id, reason),
    reviseFromChat: (id: string) => ipcRenderer.invoke('ambient:revise-from-chat', id),
    sendChatMessage: (id: string, message: string) => ipcRenderer.invoke('ambient:send-chat-message', id, message),
    getChatThread: (id: string) => ipcRenderer.invoke('ambient:get-chat-thread', id),
    cancelChatStream: (id: string) => ipcRenderer.invoke('ambient:cancel-chat-stream', id),
    approveChatAction: (intentId: string, messageId: string, editedPayload?: Record<string, unknown>) =>
      ipcRenderer.invoke('ambient:approve-chat-action', intentId, messageId, editedPayload),
    dismissChatAction: (intentId: string, messageId: string) =>
      ipcRenderer.invoke('ambient:dismiss-chat-action', intentId, messageId),
    getDigest: (slot?: string) => ipcRenderer.invoke('ambient:get-digest', slot),
    getTrayState: () => ipcRenderer.invoke('ambient:get-tray-state'),
    getPolicy: () => ipcRenderer.invoke('ambient:get-policy'),
    setTier: (actionType: string, tier: number, locked?: boolean) =>
      ipcRenderer.invoke('ambient:set-tier', actionType, tier, locked),
    resetTrust: () => ipcRenderer.invoke('ambient:reset-trust'),
    pollNow: () => ipcRenderer.invoke('ambient:poll-now'),
    getLog: (limit?: number) => ipcRenderer.invoke('ambient:get-log', limit),
    startAuthoring: (intentId: string) => ipcRenderer.invoke('ambient:start-authoring', intentId),
    getWorkProduct: (intentId: string) => ipcRenderer.invoke('ambient:get-work-product', intentId),
    shipWorkProduct: (intentId: string) => ipcRenderer.invoke('ambient:ship-work-product', intentId),
    discardWorkProduct: (intentId: string) => ipcRenderer.invoke('ambient:discard-work-product', intentId)
  },
  memory: {
    getGraph: () => ipcRenderer.invoke('memory:get-graph'),
    getNode: (id: string) => ipcRenderer.invoke('memory:get-node', id),
    getActive: (limit?: number) => ipcRenderer.invoke('memory:get-active', limit),
    deleteNode: (id: string) => ipcRenderer.invoke('memory:delete-node', id),
    deleteEdge: (id: string) => ipcRenderer.invoke('memory:delete-edge', id),
    deleteMemory: (id: string) => ipcRenderer.invoke('memory:delete-memory', id),
    updateMemory: (id: string, update: object) => ipcRenderer.invoke('memory:update-memory', id, update),
    exportMarkdown: () => ipcRenderer.invoke('memory:export-markdown')
  },
  usage: {
    getSummary: (range) => ipcRenderer.invoke('usage:get-summary', range),
    getDaily: (range) => ipcRenderer.invoke('usage:get-daily', range),
    getBySource: (range) => ipcRenderer.invoke('usage:get-by-source', range),
    getByModel: (range) => ipcRenderer.invoke('usage:get-by-model', range),
    getRecent: (limit, range) => ipcRenderer.invoke('usage:get-recent', limit, range)
  },
  checkin: {
    start: () => ipcRenderer.invoke('checkin:start'),
    getActive: () => ipcRenderer.invoke('checkin:get-active'),
    getAll: (limit?: number) => ipcRenderer.invoke('checkin:get-all', limit),
    getThread: (checkinId: string) => ipcRenderer.invoke('checkin:get-thread', checkinId),
    sendMessage: (checkinId: string, message: string) => ipcRenderer.invoke('checkin:send-message', checkinId, message),
    end: (checkinId: string) => ipcRenderer.invoke('checkin:end', checkinId),
    cancelStream: (checkinId: string) => ipcRenderer.invoke('checkin:cancel-stream', checkinId),
    openInMainWindow: (checkinId?: string) => ipcRenderer.invoke('checkin:open-in-main-window', checkinId)
  },
  update: {
    checkNow: () => ipcRenderer.invoke('update:check-now'),
    install:  () => ipcRenderer.invoke('update:install')
  },
  chat: {
    resolveToolApproval: (approvalId, allow, editedInput) =>
      ipcRenderer.invoke('chat:resolve-tool-approval', approvalId, allow, editedInput),
    answerQuestion: (questionId, answer) =>
      ipcRenderer.invoke('chat:answer-question', questionId, answer)
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
