import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron'
import { writeFileSync, statSync, readdirSync } from 'fs'
import { homedir } from 'os'
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
  dbGetPlanItem,
  dbGetPlanThread,
  dbGetBadgeCount,
  dbGetAllNodes,
  dbGetAllEdges,
  dbGetAllMemories,
  dbGetActiveMemories,
  dbGetNodeById,
  dbGetEdgesFrom,
  dbGetEdgesTo,
  dbGetMemoriesForNode,
  dbGetNodeTimeline,
  dbDeleteNode,
  dbDeleteEdge,
  dbDeleteMemory,
  dbUpdateMemory,
  dbGetUsageSummary,
  dbGetUsageByDay,
  dbGetUsageBySource,
  dbGetUsageByModel,
  dbGetRecentUsage
} from './db/index'
import { readConfig, updateConfig, clearClaudeApiKey, resetConfig } from './services/config'
import { getAllRepoLinks, addRepoLink, updateRepoLink, removeRepoLink } from './services/repos'
import { startAuthoring, getWorkProductForIntent, shipWorkProduct, discardWorkProduct } from './services/authoring'
import { reconnectServer, getServerStatus, connectAllServers, disconnectAllServers, resolveOwnerHandles, withTimeout } from './services/mcp'
import { startPkceFlow } from './services/oauth'
import { detectClaudeMcpServers } from './services/claude-import'
import { executeRoutine, handleRunMessage } from './services/routines'
import { createPlanDraft, confirmPlanDraft, updatePlanItemStatus, deletePlanItem, handlePlanMessage, approvePlanAction, dismissPlanAction } from './services/plan'
import { generateRoutineSetup, cancelStream } from './services/claude'
import { resolveAuthSource } from './services/auth'
import { resolveToolApproval, resolveQuestion } from './services/agent'
import { refreshSchedules, refreshCheckinSchedule, stopScheduler } from './services/cron'
import { buildScopeCandidates } from './services/scope'
import { startCheckIn, handleCheckInMessage, endCheckIn, cancelCheckinStream } from './services/checkin'
import {
  dbGetCheckIns,
  dbGetActiveCheckIn,
  dbGetCheckInThread,
  resetDatabase
} from './db/index'
import {
  ambientGetIntents,
  ambientGetAllIntents,
  ambientApproveIntent,
  ambientDismissIntent,
  ambientChallengeIntent,
  reviseIntentFromChat,
  ambientGetIntentChatThread,
  handleIntentChat,
  approveChatAction,
  dismissChatAction,
  ambientGetDigest,
  ambientComputeTrayState,
  ambientGetPolicy,
  ambientSetAutonomyTier,
  ambientResetTrust,
  ambientPollNow,
  startAmbient,
  stopAmbient
} from './services/ambient'
import { dbGetActionLog, dbGetIntent } from './db/index'
import { buildMemoryExportMarkdown } from './services/memory-export'
import { setTrayState } from './tray'
import { checkForUpdatesNow, installUpdate } from './services/updater'
import type { RoutineInput, PlanDraft, PlanItemStatus, RunStatus, SetupHealth, DigestSlot, Tier, UsageRange } from '@shared/types'
import { MCP_CATALOG } from '@shared/mcp-catalog'
import { broadcast, updateBadgeCount } from './windows'

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
    broadcast('plan:item-updated', { id, status })
  })

  ipcMain.handle('plan:delete', async (_e, id: string) => {
    deletePlanItem(id)
  })

  ipcMain.handle('plan:send-message', async (_e, itemId: string, message: string) => {
    await handlePlanMessage(itemId, message)
  })

  ipcMain.handle('plan:get-thread', async (_e, itemId: string) => {
    return dbGetPlanThread(itemId)
  })

  ipcMain.handle('plan:cancel-stream', (_e, itemId: string) => {
    cancelStream(itemId)
  })

  ipcMain.handle('plan:get-item', async (_e, itemId: string) => {
    return dbGetPlanItem(itemId)
  })

  ipcMain.handle('plan:open-in-main-window', async (_e, itemId: string) => {
    const win = openMainWindow()
    const send = (): void => win.webContents.send('navigate:plan-item', itemId)
    const url = win.webContents.getURL()
    const ready = url !== '' && url !== 'about:blank' && !win.webContents.isLoading()
    if (ready) {
      send()
    } else {
      win.webContents.once('did-finish-load', send)
    }
  })

  ipcMain.handle('plan:approve-chat-action', async (
    _e, itemId: string, messageId: string, editedPayload?: Record<string, unknown>
  ) => {
    return approvePlanAction(itemId, messageId, editedPayload)
  })

  ipcMain.handle('plan:dismiss-chat-action', async (
    _e, itemId: string, messageId: string
  ) => {
    return dismissPlanAction(itemId, messageId)
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
    await handleRunMessage(runId, message)
  })

  ipcMain.handle('routines:update-run-status', async (_e, runId: string, status: RunStatus) => {
    dbUpdateRun(runId, { status })
    updateBadgeCount()
  })

  ipcMain.handle('routines:generate-setup', async (_e, intent: string) => {
    const servers = getServerStatus()
    return generateRoutineSetup(intent, servers)
  })

  ipcMain.handle('routines:cancel-stream', (_e, runId: string) => {
    cancelStream(runId)
  })

  ipcMain.handle('routines:open-run-in-main-window', async (_e, runId: string) => {
    const win = openMainWindow()
    const send = (): void => win.webContents.send('navigate:run-chat', runId)
    const url = win.webContents.getURL()
    const ready = url !== '' && url !== 'about:blank' && !win.webContents.isLoading()
    if (ready) {
      send()
    } else {
      win.webContents.once('did-finish-load', send)
    }
  })

  // ─── Config ────────────────────────────────────────────────────────────────

  ipcMain.handle('config:get', async () => {
    // Strip the API key — it must never be sent to the renderer in plaintext.
    // Use getClaudeKey() for the masked preview.
    const cfg = readConfig()
    const safeConfig = { ...cfg, claude: { ...cfg.claude } }
    delete safeConfig.claude.apiKey
    return safeConfig
  })

  ipcMain.handle('config:get-claude-key', async () => {
    const key = readConfig().claude.apiKey ?? ''
    if (!key) return { configured: false, preview: null }
    // Show prefix up through the third dash (e.g. 'sk-ant-') + last 4 chars
    const parts = key.split('-')
    const prefix = parts.length >= 3 ? `${parts.slice(0, 3).join('-')}-` : key.slice(0, Math.min(10, key.length))
    const preview = key.length > 8 ? `${prefix}…${key.slice(-4)}` : '…'
    return { configured: true, preview }
  })

  ipcMain.handle('config:set-claude-key', async (_e, key: string | null) => {
    if (key && key.trim()) {
      updateConfig({ claude: { apiKey: key.trim() } })
    } else {
      clearClaudeApiKey()
    }
  })

  ipcMain.handle('config:update', async (_e, partial) => {
    // The API key has a dedicated channel (config:set-claude-key). Never allow
    // the generic update path to overwrite or clear it — the renderer never sees it.
    if (partial?.claude && 'apiKey' in partial.claude) delete partial.claude.apiKey
    const updated = updateConfig(partial)
    // Re-connect MCP servers if changed
    await connectAllServers()
    // Start/stop ambient intelligence. startAmbient() is idempotent (no-op if
    // already running, or if still gated by "ambient disabled"/"no surface
    // configured") so it's safe to call on every update — this is what makes a
    // newly added surface (first MCP server, or a newly enabled vault) take
    // effect immediately rather than requiring an app restart.
    if (updated.ambient?.enabled ?? true) {
      startAmbient(getWidgetWin)
    } else {
      stopAmbient()
    }
    // Refresh check-in schedule if checkin config changed
    if (partial.checkin !== undefined) {
      refreshCheckinSchedule(getWidgetWin)
    }
    return updated
  })

  ipcMain.handle('config:reconnect-mcp-server', async (_e, name: string) => {
    return reconnectServer(name)
  })

  ipcMain.handle('config:reconnect-all', async () => {
    await connectAllServers()
    return getServerStatus()
  })

  ipcMain.handle('config:get-mcp-status', async () => {
    return getServerStatus()
  })

  ipcMain.handle('config:get-scope-candidates', async () => {
    return buildScopeCandidates()
  })

  // ─── Repos ─────────────────────────────────────────────────────────────────

  ipcMain.handle('repos:get-all', async () => {
    return getAllRepoLinks()
  })

  ipcMain.handle('repos:add', async (_e, localPath: string, jiraProjectKeys: string[]) => {
    return addRepoLink(localPath, jiraProjectKeys)
  })

  ipcMain.handle('repos:update', async (_e, id: string, update: Record<string, unknown>) => {
    return updateRepoLink(id, update)
  })

  ipcMain.handle('repos:remove', async (_e, id: string) => {
    removeRepoLink(id)
  })

  // ─── OAuth ─────────────────────────────────────────────────────────────────

  ipcMain.handle('oauth:start-pkce', async (_e, provider: 'notion' | 'linear') => {
    return startPkceFlow(provider)
  })

  // ─── Setup / Health ────────────────────────────────────────────────────────

  ipcMain.handle('setup:check-prerequisites', async () => {
    return resolveAuthSource()
  })

  ipcMain.handle('setup:get-health', async (): Promise<SetupHealth> => {
    const auth = resolveAuthSource()

    const config = readConfig()
    const statuses = getServerStatus()
    const now = Date.now()

    const servers = config.mcp_servers.map((srv) => {
      const disabled = srv.enabled === false
      const status = statuses.find((s) => s.name === srv.name)
      const entry = MCP_CATALOG.find((e) => e.id === srv.name)

      // Skip credential / path validation for disabled servers — they are
      // intentionally not connected, so auth warnings would be misleading.
      if (disabled) {
        return {
          name: srv.name,
          connected: false,
          disabled: true,
          missingEnvKeys: [],
          oauthProvider: entry?.oauthProvider
        }
      }

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

      // Validate path-type arg inputs (e.g. filesystem allowed directories)
      const invalidArgs: string[] = []
      const pathArgInputs = entry?.argInputs?.filter((a) => a.isPath) ?? []
      if (pathArgInputs.length > 0) {
        const baseArgCount = entry?.baseArgs.length ?? 0
        const dirs = (srv.args ?? []).slice(baseArgCount)
        if (dirs.length === 0) {
          invalidArgs.push('No allowed directories configured')
        } else {
          for (const raw of dirs) {
            // Expand leading tilde for validation (same logic as mcp.ts expandTildeArgs)
            const expanded = raw.startsWith('~/')
              ? homedir() + raw.slice(1)
              : raw === '~' ? homedir() : raw
            if (!expanded.startsWith('/')) {
              invalidArgs.push(`Not an absolute path: ${raw}`)
            } else {
              try {
                if (!statSync(expanded).isDirectory()) invalidArgs.push(`Directory not found: ${raw}`)
              } catch {
                invalidArgs.push(`Directory not found: ${raw}`)
              }
            }
          }
        }
      }

      const provider = entry?.oauthProvider as string | undefined
      const oauthConnectedAt = provider
        ? config.oauth_connected_at?.[provider as 'notion' | 'linear']
        : undefined
      const oauthStaleDays =
        oauthConnectedAt
          ? Math.floor((now - Date.parse(oauthConnectedAt)) / 86_400_000)
          : undefined

      return {
        name: srv.name,
        connected: status?.connected ?? false,
        missingEnvKeys,
        invalidArgs: invalidArgs.length > 0 ? invalidArgs : undefined,
        oauthProvider: entry?.oauthProvider,
        oauthConnectedAt,
        oauthStaleDays
      }
    })

    return { auth, servers }
  })

  ipcMain.handle('setup:detect-claude-mcp', () => detectClaudeMcpServers())

  ipcMain.handle('setup:resolve-owner-handles', () => resolveOwnerHandles())

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

  ipcMain.handle('system:open-external', async (_e, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle('system:factory-reset', async () => {
    // Tear down background services before wiping data. Bounded the same way
    // as the app-quit cleanup path — a hung stdio MCP server must not block
    // factory reset indefinitely.
    try { stopAmbient() } catch { /* ignore */ }
    try { stopScheduler() } catch { /* ignore */ }
    try { await withTimeout(disconnectAllServers(), 3_000, 'disconnectAllServers on factory reset') } catch { /* ignore */ }
    // Wipe persistent state
    resetDatabase()
    resetConfig()
    // Relaunch into a fresh onboarding session
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('system:pick-directory', async (_e, multiple?: boolean) => {
    const result = await dialog.showOpenDialog({
      title: 'Select directory',
      properties: multiple
        ? ['openDirectory', 'createDirectory', 'multiSelections']
        : ['openDirectory', 'createDirectory']
    })
    return result.canceled ? [] : result.filePaths
  })

  // ─── Knowledge (vault) ───────────────────────────────────────────────────────

  ipcMain.handle('knowledge:list-vault-folders', async (_e, path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  })

  // ─── Ambient ───────────────────────────────────────────────────────────────

  function refreshAmbientTray(): void {
    setTrayState(ambientComputeTrayState())
  }

  ipcMain.handle('ambient:get-intents', async () => {
    return ambientGetIntents()
  })

  ipcMain.handle('ambient:get-all-intents', async (_e, limit?: number) => {
    return ambientGetAllIntents(limit)
  })

  ipcMain.handle('ambient:approve', async (_e, id: string, payload?: Record<string, unknown>) => {
    const intent = await ambientApproveIntent(id, payload)
    // broadcast updated intent so both windows reflect the new status
    broadcast('ambient:intent-updated', intent)
    refreshAmbientTray()
    updateBadgeCount()
    return intent
  })

  ipcMain.handle('ambient:dismiss', async (_e, id: string) => {
    const intent = ambientDismissIntent(id)
    // broadcast to all windows so Activity page reflects dismissals too
    broadcast('ambient:intent-updated', intent)
    refreshAmbientTray()
    updateBadgeCount()
  })

  ipcMain.handle('ambient:challenge', async (_e, id: string, reason: string) => {
    const intent = await ambientChallengeIntent(id, reason)
    broadcast('ambient:intent-updated', intent)
    refreshAmbientTray()
    updateBadgeCount()
    return intent
  })

  ipcMain.handle('ambient:revise-from-chat', async (_e, id: string) => {
    const result = await reviseIntentFromChat(id)
    if (result) {
      broadcast('ambient:intent-updated', result.intent)
    }
    refreshAmbientTray()
    updateBadgeCount()
    return result
  })

  ipcMain.handle('ambient:get-chat-thread', async (_e, id: string) => {
    return ambientGetIntentChatThread(id)
  })

  ipcMain.handle('ambient:send-chat-message', async (_e, id: string, message: string) => {
    await handleIntentChat(id, message)
  })

  ipcMain.handle('ambient:cancel-chat-stream', async (_e, id: string) => {
    cancelStream(`intentchat:${id}`)
  })

  ipcMain.handle('ambient:approve-chat-action', async (
    _e, intentId: string, messageId: string, editedPayload?: Record<string, unknown>
  ) => {
    return approveChatAction(intentId, messageId, editedPayload)
  })

  ipcMain.handle('ambient:dismiss-chat-action', async (
    _e, intentId: string, messageId: string
  ) => {
    return dismissChatAction(intentId, messageId)
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

  ipcMain.handle('ambient:start-authoring', async (_e, intentId: string) => {
    const wp = await startAuthoring(intentId)
    // The intent's status changes (pending/surfaced → approved, or → failed on error)
    // as a side effect of starting — reflect that in both windows immediately.
    broadcast('ambient:intent-updated', dbGetIntent(intentId))
    refreshAmbientTray()
    updateBadgeCount()
    return wp
  })

  ipcMain.handle('ambient:get-work-product', async (_e, intentId: string) => {
    return getWorkProductForIntent(intentId)
  })

  ipcMain.handle('ambient:ship-work-product', async (_e, intentId: string) => {
    const intent = await shipWorkProduct(intentId)
    broadcast('ambient:intent-updated', intent)
    refreshAmbientTray()
    updateBadgeCount()
    return intent
  })

  ipcMain.handle('ambient:discard-work-product', async (_e, intentId: string) => {
    await discardWorkProduct(intentId)
    broadcast('ambient:intent-updated', dbGetIntent(intentId))
    refreshAmbientTray()
    updateBadgeCount()
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

  ipcMain.handle('memory:get-active', (_e, limit?: number) => {
    return dbGetActiveMemories(limit)
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

  // ─── Usage ────────────────────────────────────────────────────────────────

  ipcMain.handle('usage:get-summary', (_e, range: UsageRange) => {
    return dbGetUsageSummary(range)
  })

  ipcMain.handle('usage:get-daily', (_e, range: UsageRange) => {
    return dbGetUsageByDay(range)
  })

  ipcMain.handle('usage:get-by-source', (_e, range: UsageRange) => {
    return dbGetUsageBySource(range)
  })

  ipcMain.handle('usage:get-by-model', (_e, range: UsageRange) => {
    return dbGetUsageByModel(range)
  })

  ipcMain.handle('usage:get-recent', (_e, limit: number, range: UsageRange) => {
    return dbGetRecentUsage(limit, range)
  })

  // ─── Check-in ─────────────────────────────────────────────────────────────

  ipcMain.handle('checkin:start', async () => {
    return startCheckIn('manual', getWidgetWin())
  })

  ipcMain.handle('checkin:get-active', async () => {
    return dbGetActiveCheckIn()
  })

  ipcMain.handle('checkin:get-all', async (_e, limit?: number) => {
    return dbGetCheckIns(limit)
  })

  ipcMain.handle('checkin:get-thread', async (_e, checkinId: string) => {
    return dbGetCheckInThread(checkinId)
  })

  ipcMain.handle('checkin:send-message', async (_e, checkinId: string, message: string) => {
    await handleCheckInMessage(checkinId, message, getWidgetWin())
  })

  ipcMain.handle('checkin:end', async (_e, checkinId: string) => {
    endCheckIn(checkinId).catch(console.error)
  })

  ipcMain.handle('checkin:cancel-stream', (_e, checkinId: string) => {
    cancelCheckinStream(checkinId)
  })

  ipcMain.handle('checkin:open-in-main-window', async (_e, checkinId?: string) => {
    const win = openMainWindow()
    const send = (): void => win.webContents.send('navigate:checkin', checkinId ?? null)
    const url = win.webContents.getURL()
    const ready = url !== '' && url !== 'about:blank' && !win.webContents.isLoading()
    if (ready) {
      send()
    } else {
      win.webContents.once('did-finish-load', send)
    }
  })

  // ─── Update ───────────────────────────────────────────────────────────────

  ipcMain.handle('update:check-now', () => {
    checkForUpdatesNow()
  })

  ipcMain.handle('update:install', () => {
    installUpdate()
  })

  ipcMain.handle('chat:resolve-tool-approval', (
    _e,
    approvalId: string,
    allow: boolean,
    editedInput?: Record<string, unknown>
  ) => {
    resolveToolApproval(approvalId, allow, editedInput)
  })

  ipcMain.handle('chat:answer-question', (
    _e,
    questionId: string,
    answer: string | string[]
  ) => {
    resolveQuestion(questionId, answer)
  })
}
