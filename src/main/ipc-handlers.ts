import { ipcMain, BrowserWindow, dialog } from 'electron'
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import {
  dbGetRoutines,
  dbCreateRoutine,
  dbUpdateRoutine,
  dbDeleteRoutine,
  dbGetRunsForRoutine,
  dbGetAllRuns,
  dbGetRunThread,
  dbUpdateRun,
  dbGetPlanItems,
  dbGetPlanThread,
  dbGetBadgeCount,
  dbGetAllNodes,
  dbGetAllEdges,
  dbGetAllMemories,
  dbGetNodeById,
  dbGetEdgesFrom,
  dbGetEdgesTo,
  dbGetMemoriesForNode,
  dbGetNodeTimeline,
  dbDeleteNode,
  dbDeleteEdge,
  dbDeleteMemory,
  dbUpdateMemory
} from './db/index'
import { readConfig, updateConfig } from './services/config'
import { testServer, getServerStatus, connectAllServers } from './services/mcp'
import { startDeviceFlow, pollDeviceFlow, startPkceFlow } from './services/oauth'
import { detectClaudeMcpServers } from './services/claude-import'
import { executeRoutine, handleRunMessage } from './services/routines'
import { createPlanDraft, confirmPlanDraft, updatePlanItemStatus, deletePlanItem, handlePlanMessage } from './services/plan'
import { generateRoutineSetup, cancelStream } from './services/claude'
import { refreshSchedules } from './services/cron'
import {
  ambientGetIntents,
  ambientApproveIntent,
  ambientDismissIntent,
  ambientChallengeIntent,
  ambientGetDigest,
  ambientComputeTrayState,
  ambientGetPolicy,
  ambientSetAutonomyTier,
  ambientResetTrust,
  ambientPollNow,
  startAmbient,
  stopAmbient
} from './services/ambient'
import { dbGetActionLog } from './db/index'
import { buildMemoryExportMarkdown } from './services/memory-export'
import { setTrayState } from './tray'
import type { RoutineInput, PlanDraft, PlanItemStatus, RunStatus, McpServerConfig, SetupHealth, DigestSlot, Tier } from '@shared/types'
import { MCP_CATALOG } from '@shared/mcp-catalog'

export function registerIpcHandlers(
  getWidgetWin: () => BrowserWindow | null,
  openMainWindow: () => BrowserWindow
): void {

  // ─── Plan ─────────────────────────────────────────────────────────────────

  ipcMain.handle('plan:create-draft', async (_e, intent: string) => {
    return createPlanDraft(intent)
  })

  ipcMain.handle('plan:confirm', async (_e, draft: PlanDraft) => {
    return confirmPlanDraft(draft)
  })

  ipcMain.handle('plan:get-all', async () => {
    return dbGetPlanItems()
  })

  ipcMain.handle('plan:update-status', async (_e, id: string, status: PlanItemStatus) => {
    updatePlanItemStatus(id, status)
  })

  ipcMain.handle('plan:delete', async (_e, id: string) => {
    deletePlanItem(id)
  })

  ipcMain.handle('plan:send-message', async (_e, itemId: string, message: string) => {
    await handlePlanMessage(itemId, message, getWidgetWin())
  })

  ipcMain.handle('plan:get-thread', async (_e, itemId: string) => {
    return dbGetPlanThread(itemId)
  })

  ipcMain.handle('plan:cancel-stream', (_e, itemId: string) => {
    cancelStream(itemId)
  })

  // ─── Routines ──────────────────────────────────────────────────────────────

  ipcMain.handle('routines:get-all', async () => {
    return dbGetRoutines()
  })

  ipcMain.handle('routines:create', async (_e, data: RoutineInput) => {
    const routine = dbCreateRoutine(data)
    refreshSchedules(getWidgetWin)
    return routine
  })

  ipcMain.handle('routines:update', async (_e, id: string, data: Partial<RoutineInput>) => {
    const routine = dbUpdateRoutine(id, data)
    refreshSchedules(getWidgetWin)
    return routine
  })

  ipcMain.handle('routines:delete', async (_e, id: string) => {
    dbDeleteRoutine(id)
    refreshSchedules(getWidgetWin)
  })

  ipcMain.handle('routines:run-now', async (_e, id: string) => {
    const routines = dbGetRoutines()
    const routine = routines.find((r) => r.id === id)
    if (!routine) throw new Error(`Routine ${id} not found`)
    executeRoutine(routine, getWidgetWin()).catch(console.error)
  })

  ipcMain.handle('routines:get-runs', async (_e, routineId: string, limit?: number) => {
    return dbGetRunsForRoutine(routineId, limit)
  })

  ipcMain.handle('routines:get-all-runs', async (_e, limit?: number) => {
    return dbGetAllRuns(limit)
  })

  ipcMain.handle('routines:get-thread', async (_e, runId: string) => {
    return dbGetRunThread(runId)
  })

  ipcMain.handle('routines:send-message', async (_e, runId: string, message: string) => {
    await handleRunMessage(runId, message, getWidgetWin())
  })

  ipcMain.handle('routines:update-run-status', async (_e, runId: string, status: RunStatus) => {
    dbUpdateRun(runId, { status })
    getWidgetWin()?.webContents.send('badge:updated', dbGetBadgeCount())
  })

  ipcMain.handle('routines:generate-setup', async (_e, intent: string) => {
    const servers = getServerStatus()
    return generateRoutineSetup(intent, servers)
  })

  ipcMain.handle('routines:cancel-stream', (_e, runId: string) => {
    cancelStream(runId)
  })

  // ─── Config ────────────────────────────────────────────────────────────────

  ipcMain.handle('config:get', async () => {
    return readConfig()
  })

  ipcMain.handle('config:update', async (_e, partial) => {
    const wasEnabled = readConfig().ambient?.enabled ?? true
    const updated = updateConfig(partial)
    // Re-connect MCP servers if changed
    await connectAllServers()
    // Start/stop ambient intelligence on enabled transitions
    const nowEnabled = updated.ambient?.enabled ?? true
    if (!wasEnabled && nowEnabled) {
      startAmbient(getWidgetWin)
    } else if (wasEnabled && !nowEnabled) {
      stopAmbient()
    }
    return updated
  })

  ipcMain.handle('config:test-mcp-server', async (_e, cfg: McpServerConfig) => {
    return testServer(cfg)
  })

  ipcMain.handle('config:get-mcp-status', async () => {
    return getServerStatus()
  })

  // ─── OAuth ─────────────────────────────────────────────────────────────────

  ipcMain.handle('oauth:start-device', async () => {
    return startDeviceFlow()
  })

  ipcMain.handle('oauth:poll-device', async (_e, deviceCode: string) => {
    return pollDeviceFlow(deviceCode)
  })

  ipcMain.handle('oauth:start-pkce', async (_e, provider: 'notion' | 'linear') => {
    return startPkceFlow(provider)
  })

  // ─── Setup / Health ────────────────────────────────────────────────────────

  ipcMain.handle('setup:check-prerequisites', async (): Promise<{ claudeCli: boolean }> => {
    let claudeCli = false
    try {
      execFileSync('/usr/bin/which', ['claude'], { stdio: 'ignore' })
      claudeCli = true
    } catch {
      // not found
    }
    return { claudeCli }
  })

  ipcMain.handle('setup:get-health', async (): Promise<SetupHealth> => {
    let claudeCli = false
    try {
      execFileSync('/usr/bin/which', ['claude'], { stdio: 'ignore' })
      claudeCli = true
    } catch {
      // not found
    }

    const config = readConfig()
    const statuses = getServerStatus()
    const now = Date.now()

    const servers = config.mcp_servers.map((srv) => {
      const status = statuses.find((s) => s.name === srv.name)
      const entry = MCP_CATALOG.find((e) => e.id === srv.name)

      const missingEnvKeys: string[] = []
      if (entry?.authType === 'oauth' && entry.oauthTokenEnvKey) {
        if (!srv.env?.[entry.oauthTokenEnvKey]?.trim()) {
          missingEnvKeys.push(entry.oauthTokenEnvKey)
        }
      } else if (entry?.authType === 'api_key' && entry.requiredEnv) {
        for (const field of entry.requiredEnv) {
          if (!srv.env?.[field.key]?.trim()) missingEnvKeys.push(field.key)
        }
      }

      const provider = entry?.oauthProvider as string | undefined
      const oauthConnectedAt = provider
        ? config.oauth_connected_at?.[provider as 'github' | 'notion' | 'linear']
        : undefined
      const oauthStaleDays =
        oauthConnectedAt
          ? Math.floor((now - Date.parse(oauthConnectedAt)) / 86_400_000)
          : undefined

      return {
        name: srv.name,
        connected: status?.connected ?? false,
        missingEnvKeys,
        oauthProvider: entry?.oauthProvider,
        oauthConnectedAt,
        oauthStaleDays
      }
    })

    return { claudeCli, servers }
  })

  ipcMain.handle('setup:detect-claude-mcp', () => detectClaudeMcpServers())

  // ─── System ────────────────────────────────────────────────────────────────

  ipcMain.handle('system:open-main-window', async (_e, routineId?: string) => {
    const win = openMainWindow()
    if (routineId) {
      const send = (): void => win.webContents.send('navigate:edit-routine', routineId)
      const url = win.webContents.getURL()
      const ready = url !== '' && url !== 'about:blank' && !win.webContents.isLoading()
      if (ready) {
        send()
      } else {
        win.webContents.once('did-finish-load', send)
      }
    }
  })

  ipcMain.handle('system:get-badge-count', async () => {
    return dbGetBadgeCount()
  })

  ipcMain.handle('system:get-window-type', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return 'unknown'
    return win.getTitle().includes('widget') ? 'widget' : 'main-window'
  })

  // ─── Ambient ───────────────────────────────────────────────────────────────

  function refreshAmbientTray(): void {
    setTrayState(ambientComputeTrayState())
  }

  ipcMain.handle('ambient:get-intents', async () => {
    return ambientGetIntents()
  })

  ipcMain.handle('ambient:approve', async (_e, id: string) => {
    const intent = await ambientApproveIntent(id)
    getWidgetWin()?.webContents.send('ambient:intent-updated', intent)
    refreshAmbientTray()
    getWidgetWin()?.webContents.send('badge:updated', dbGetBadgeCount())
    return intent
  })

  ipcMain.handle('ambient:dismiss', async (_e, id: string) => {
    const intent = ambientDismissIntent(id)
    // Send a full Intent object (same shape as approve/challenge) so renderer can merge it
    getWidgetWin()?.webContents.send('ambient:intent-updated', intent)
    refreshAmbientTray()
    getWidgetWin()?.webContents.send('badge:updated', dbGetBadgeCount())
  })

  ipcMain.handle('ambient:challenge', async (_e, id: string, reason: string) => {
    const intent = await ambientChallengeIntent(id, reason)
    getWidgetWin()?.webContents.send('ambient:intent-updated', intent)
    refreshAmbientTray()
    return intent
  })

  ipcMain.handle('ambient:get-digest', async (_e, slot?: DigestSlot) => {
    return ambientGetDigest(slot)
  })

  ipcMain.handle('ambient:get-tray-state', async () => {
    return ambientComputeTrayState()
  })

  ipcMain.handle('ambient:get-policy', async () => {
    return ambientGetPolicy()
  })

  ipcMain.handle('ambient:set-tier', async (_e, actionType: string, tier: Tier, locked?: boolean) => {
    // Validate inputs to prevent renderer from writing arbitrary tier values
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
      throw new Error(`Invalid tier ${tier}: must be 0–3`)
    }
    if (typeof actionType !== 'string' || actionType.trim() === '') {
      throw new Error('Invalid actionType')
    }
    ambientSetAutonomyTier(actionType, tier, locked)
  })

  ipcMain.handle('ambient:reset-trust', async () => {
    ambientResetTrust()
  })

  ipcMain.handle('ambient:poll-now', async () => {
    await ambientPollNow()
  })

  ipcMain.handle('ambient:get-log', async (_e, limit?: number) => {
    return dbGetActionLog(limit)
  })

  // ─── Memory graph ──────────────────────────────────────────────────────────

  ipcMain.handle('memory:get-graph', async () => {
    return { nodes: dbGetAllNodes(), edges: dbGetAllEdges() }
  })

  ipcMain.handle('memory:get-node', async (_e, id: string) => {
    const node = dbGetNodeById(id)
    if (!node) return null
    const edges = [...dbGetEdgesFrom(id), ...dbGetEdgesTo(id)]
    const memories = dbGetMemoriesForNode(id)
    const timeline = dbGetNodeTimeline(id, 20)
    return { node, edges, memories, timeline }
  })

  ipcMain.handle('memory:delete-node', async (_e, id: string) => {
    dbDeleteNode(id)
  })

  ipcMain.handle('memory:delete-edge', async (_e, id: string) => {
    dbDeleteEdge(id)
  })

  ipcMain.handle('memory:delete-memory', async (_e, id: string) => {
    dbDeleteMemory(id)
  })

  ipcMain.handle('memory:update-memory', async (_e, id: string, update: { content?: string; importance?: number; status?: 'active' | 'superseded' }) => {
    dbUpdateMemory(id, update)
  })

  ipcMain.handle('memory:export-markdown', async () => {
    const dateStr = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog({
      title: 'Export memory',
      defaultPath: `mypa-memory-export-${dateStr}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) {
      return { saved: false }
    }
    const memories = dbGetAllMemories()
    const nodes = dbGetAllNodes()
    const edges = dbGetAllEdges()
    const markdown = buildMemoryExportMarkdown(memories, nodes, edges)
    writeFileSync(result.filePath, markdown, 'utf8')
    return { saved: true, path: result.filePath }
  })
}
