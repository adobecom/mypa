// ─── Plan ───────────────────────────────────────────────────────────────────

export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'skipped'
export type PlanItemTiming = 'now' | 'morning' | 'afternoon' | 'evening' | 'anytime'
export type PlanItemSource = 'manual_input' | 'routine_suggestion'

export interface McpActionRef {
  server: string
  tool: string
  params: Record<string, unknown>
}

export interface PlanItem {
  id: string
  title: string
  detail: string
  status: PlanItemStatus
  timing: PlanItemTiming
  source: PlanItemSource
  created_at: string
  actions: McpActionRef[]
}

export interface PlanDraft {
  title: string
  detail: string
  timing: PlanItemTiming
  actions: McpActionRef[]
  original_intent: string
}

// ─── Routines ────────────────────────────────────────────────────────────────

export interface RoutineAction {
  server: string
  tool: string
  params: Record<string, unknown>
}

export interface Routine {
  id: string
  name: string
  cron: string
  actions: RoutineAction[]
  prompt: string
  enabled: boolean
  created_at: string
}

export type RoutineInput = Omit<Routine, 'id' | 'created_at'>

export interface RoutineSetupDraft {
  name: string
  actions: RoutineAction[]
  prompt: string
  cron?: string
}

export type RunStatus = 'running' | 'pending_response' | 'in_progress' | 'resolved' | 'dismissed' | 'error'

export interface RoutineRun {
  id: string
  routine_id: string
  routine_name: string
  started_at: string
  completed_at: string | null
  raw_output: string | null
  digest: string | null
  status: RunStatus
  error: string | null
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: string
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export type OAuthProvider = 'github' | 'notion' | 'linear'

export interface DeviceFlowStart {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpServerStatus {
  name: string
  connected: boolean
  tools: McpTool[]
  error?: string
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ClaudeConfig {
  model?: string
}

export interface AppPreferences {
  widget_always_on_top: boolean
  notification_sound: boolean
  launch_on_login: boolean
}

export interface AppConfig {
  claude: ClaudeConfig
  mcp_servers: McpServerConfig[]
  preferences: AppPreferences
}

export const DEFAULT_CONFIG: AppConfig = {
  claude: { model: 'claude-opus-4-8' },
  mcp_servers: [],
  preferences: {
    widget_always_on_top: false,
    notification_sound: true,
    launch_on_login: false
  }
}

// ─── IPC API shape ───────────────────────────────────────────────────────────

export interface IpcApi {
  plan: {
    createDraft(intent: string): Promise<PlanDraft>
    confirm(draft: PlanDraft): Promise<PlanItem>
    getAll(): Promise<PlanItem[]>
    updateStatus(id: string, status: PlanItemStatus): Promise<void>
    delete(id: string): Promise<void>
    sendMessage(itemId: string, message: string): Promise<void>
    getThread(itemId: string): Promise<ChatMessage[]>
    cancelStream(itemId: string): Promise<void>
  }
  routines: {
    getAll(): Promise<Routine[]>
    create(data: RoutineInput): Promise<Routine>
    update(id: string, data: Partial<RoutineInput>): Promise<Routine>
    delete(id: string): Promise<void>
    runNow(id: string): Promise<void>
    getRuns(routineId: string, limit?: number): Promise<RoutineRun[]>
    getAllRuns(limit?: number): Promise<RoutineRun[]>
    getThread(runId: string): Promise<ChatMessage[]>
    sendMessage(runId: string, message: string): Promise<void>
    updateRunStatus(runId: string, status: RunStatus): Promise<void>
    generateSetup(intent: string): Promise<RoutineSetupDraft>
    cancelStream(runId: string): Promise<void>
  }
  config: {
    get(): Promise<AppConfig>
    update(config: Partial<AppConfig>): Promise<void>
    testMcpServer(cfg: McpServerConfig): Promise<{ ok: boolean; tools: McpTool[]; error?: string }>
    getMcpStatus(): Promise<McpServerStatus[]>
  }
  oauth: {
    startDevice(): Promise<DeviceFlowStart>
    pollDevice(deviceCode: string): Promise<string>
    startPkce(provider: 'notion' | 'linear'): Promise<string>
  }
  system: {
    openMainWindow(routineId?: string): Promise<void>
    getBadgeCount(): Promise<number>
    getWindowType(): 'widget' | 'main-window'
  }
  on(
    channel:
      | 'routine:run-started'
      | 'routine:run-completed'
      | 'routine:run-message'
      | 'plan:item-message'
      | 'badge:updated'
      | 'navigate:edit-routine',
    listener: (...args: unknown[]) => void
  ): () => void
}
