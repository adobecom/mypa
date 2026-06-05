import { ipcMain, BrowserWindow } from 'electron'
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
  dbGetBadgeCount
} from './db/index'
import { readConfig, updateConfig } from './services/config'
import { testServer, getServerStatus, connectAllServers } from './services/mcp'
import { startDeviceFlow, pollDeviceFlow, startPkceFlow } from './services/oauth'
import { executeRoutine, handleRunMessage } from './services/routines'
import { createPlanDraft, confirmPlanDraft, updatePlanItemStatus, deletePlanItem, handlePlanMessage } from './services/plan'
import { generateRoutineSetup } from './services/claude'
import { refreshSchedules } from './services/cron'
import type { RoutineInput, PlanDraft, PlanItemStatus, RunStatus, McpServerConfig } from '@shared/types'

export function registerIpcHandlers(
  getWidgetWin: () => BrowserWindow | null,
  openMainWindow: () => void
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

  // ─── Config ────────────────────────────────────────────────────────────────

  ipcMain.handle('config:get', async () => {
    return readConfig()
  })

  ipcMain.handle('config:update', async (_e, partial) => {
    const updated = updateConfig(partial)
    // Re-connect MCP servers if changed
    await connectAllServers()
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

  // ─── System ────────────────────────────────────────────────────────────────

  ipcMain.handle('system:open-main-window', async () => {
    openMainWindow()
  })

  ipcMain.handle('system:get-badge-count', async () => {
    return dbGetBadgeCount()
  })

  ipcMain.handle('system:get-window-type', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return 'unknown'
    return win.getTitle().includes('widget') ? 'widget' : 'main-window'
  })
}
