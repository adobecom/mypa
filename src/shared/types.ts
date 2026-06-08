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

export interface DetectedMcpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** 'stdio' | 'http' | 'sse' */
  type: string
  /** true only for stdio servers (command present) */
  supported: boolean
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

export interface OAuthAppCredential {
  clientId: string
  clientSecret?: string
}

export interface OwnerIdentity {
  name?: string
  handles?: {
    github?: string
    slack?: string
    jira?: string
    linear?: string
    notion?: string
  }
}

/** Return type for setup.resolveOwnerHandles — one entry per surface where a handle was found */
export type ResolvedHandle = { value: string; needsReview: boolean }
export type ResolvedOwnerHandles = Partial<Record<'github' | 'slack' | 'jira' | 'linear' | 'notion', ResolvedHandle>>

export interface AppConfig {
  claude: ClaudeConfig
  mcp_servers: McpServerConfig[]
  preferences: AppPreferences
  persona?: string
  owner?: OwnerIdentity
  oauth_apps?: {
    github?: OAuthAppCredential
    notion?: OAuthAppCredential
    linear?: OAuthAppCredential
  }
  onboarding_complete?: boolean
  oauth_connected_at?: {
    github?: string
    notion?: string
    linear?: string
  }
  ambient?: AmbientConfig
}

export const DEFAULT_CONFIG: AppConfig = {
  claude: { model: 'claude-opus-4-8' },
  mcp_servers: [],
  preferences: {
    widget_always_on_top: false,
    notification_sound: true,
    launch_on_login: false
  },
  onboarding_complete: false,
  ambient: {
    enabled: true,
    pollIntervalMs: 5 * 60 * 1000,
    decayHalfLifeDays: 7,
    confidenceFloor: 0.4
  }
}

// ─── Ambient Intelligence ────────────────────────────────────────────────────

export type IntentSurface = 'github' | 'jira' | 'slack'
export type IntentType = 'action' | 'suggestion' | 'flag' | 'digest'
export type IntentStatus =
  | 'pending'
  | 'surfaced'
  | 'approved'
  | 'executed'
  | 'challenged'
  | 'dismissed'
  | 'expired'
  | 'failed'
export type IntentReversibility = 'reversible' | 'irreversible'
export type TriggerKind = 'spike' | 'staleness' | 'dependency' | 'threshold' | 'time'
export type Tier = 0 | 1 | 2 | 3
export type TrayState = 'idle' | 'has-something' | 'needs-you'
export type DigestSlot = 'morning' | 'midday' | 'eod'
export type NodeType =
  // Layer 1 — Observed world (from signals)
  | 'person'
  | 'repo'
  | 'project'
  | 'channel'
  | 'sprint'
  | 'pull_request'
  | 'issue'
  | 'message'
  | 'document'
  // Layer 2 — Semantic
  | 'topic'
  // Layer 3 — Assistant cognition
  | 'decision'
  | 'intent'
  | 'routine'
  | 'plan_item'
export type EdgeRel =
  // Participation (person ↔ work item)
  | 'authored'
  | 'reviews'
  | 'assigned_to'
  | 'mentioned_in'
  | 'participates_in'
  // Structure (containment)
  | 'part_of'
  // Dependency
  | 'blocked_by'
  | 'depends_on'
  | 'waiting_for'
  | 'relates_to'
  | 'references'
  // Semantic
  | 'about'
  | 'similar_to'
  // Cognition bridges
  | 'targets'
  | 'addresses'
  | 'produced'
  | 'concerns'
  | 'deferred'

export interface ProposedAction {
  surface: IntentSurface
  verb: string
  target: string
  payload: Record<string, unknown>
}

export interface IntentObject {
  type: IntentType
  confidence: number
  proposed_action: ProposedAction
  rationale: string
  reversibility: IntentReversibility
  required_approval: boolean
}

export interface Intent {
  id: string
  type: IntentType
  trigger_kind: TriggerKind
  confidence: number
  surface: IntentSurface | null
  verb: string | null
  target: string | null
  payload: Record<string, unknown>
  rationale: string
  reversibility: IntentReversibility
  required_approval: boolean
  tier: Tier
  status: IntentStatus
  context_packet: Record<string, unknown>
  created_at: string
  resolved_at: string | null
  error: string | null
}

export interface Signal {
  id: string
  surface: IntentSurface
  kind: string
  external_id: string
  fingerprint: string
  title: string
  body: string
  actor: string
  url: string
  raw: Record<string, unknown>
  occurred_at: string | null
  observed_at: string
  processed: boolean
}

export type SignalInput = Omit<Signal, 'id' | 'observed_at' | 'processed'>

export interface GraphNode {
  id: string
  type: NodeType
  key: string
  label: string
  attrs: Record<string, unknown>
  weight: number
  first_seen: string
  last_seen: string
}

export interface GraphEdge {
  id: string
  src_id: string
  dst_id: string
  rel: EdgeRel
  weight: number
  attrs: Record<string, unknown>
  first_seen: string
  last_seen: string
}

export interface AutonomyPolicy {
  action_type: string
  tier: Tier
  tier_locked: boolean
  approvals: number
  consecutive_approvals: number
  challenges: number
  dismissals: number
  executions: number
  updated_at: string
}

export interface ActionLogEntry {
  id: string
  intent_id: string | null
  event: string
  action_type: string
  tier: number | null
  detail: Record<string, unknown>
  created_at: string
}

export interface DigestSection {
  did: string[]
  watching: string[]
  decisions: string[]
}

export interface AmbientDigest {
  slot: DigestSlot
  generated_at: string
  section: DigestSection
}

export interface AmbientConfig {
  enabled: boolean
  pollIntervalMs: number
  decayHalfLifeDays: number
  confidenceFloor: number
}

export type MemoryType = 'fact' | 'pattern' | 'preference' | 'status'

export interface Memory {
  id: string
  content: string
  type: MemoryType
  confidence: number
  importance: number
  surface: string
  node_id: string | null
  status: 'active' | 'superseded'
  superseded_by: string | null
  created_at: string
  last_accessed: string | null
}

export type MemoryInput = Omit<Memory, 'id' | 'created_at' | 'status' | 'superseded_by' | 'last_accessed'>

export interface NodeSignalLink {
  id: string
  node_id: string
  signal_id: string
  surface: string
  summary: string
  occurred_at: string | null
  observed_at: string
}

// ─── Usage tracking ──────────────────────────────────────────────────────────

export type UsageSource =
  | 'plan_draft'
  | 'routine_digest'
  | 'routine_setup'
  | 'routine_chat'
  | 'plan_chat'
  | 'inference'
  | 'memory'
  | 'chat'
  | 'other'

export type UsageRange = '7d' | '30d' | '90d' | 'all'

export interface UsageEvent {
  id: string
  source: UsageSource
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  cost_usd: number
  created_at: string
}

export interface UsageSummary {
  total_input: number
  total_output: number
  total_cache_creation: number
  total_cache_read: number
  total_cost: number
  call_count: number
}

export interface UsageDailyPoint {
  day: string
  input_tokens: number
  output_tokens: number
  cost: number
  calls: number
}

export interface UsageBreakdownRow {
  key: string
  tokens: number
  cost: number
  calls: number
}

// ─── Setup / Health ───────────────────────────────────────────────────────────

export interface SetupHealthServer {
  name: string
  connected: boolean
  missingEnvKeys: string[]
  oauthProvider?: OAuthProvider
  oauthConnectedAt?: string
  oauthStaleDays?: number
}

export interface SetupHealth {
  claudeCli: boolean
  servers: SetupHealthServer[]
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
  setup: {
    checkPrerequisites(): Promise<{ claudeCli: boolean }>
    getHealth(): Promise<SetupHealth>
    detectClaudeMcp(): Promise<DetectedMcpServer[]>
    resolveOwnerHandles(): Promise<ResolvedOwnerHandles>
  }
  system: {
    openMainWindow(routineId?: string): Promise<void>
    getBadgeCount(): Promise<number>
    getWindowType(): 'widget' | 'main-window'
  }
  ambient: {
    getIntents(): Promise<Intent[]>
    approve(id: string): Promise<Intent>
    dismiss(id: string): Promise<void>
    challenge(id: string, reason: string): Promise<Intent>
    getDigest(slot?: DigestSlot): Promise<AmbientDigest>
    getTrayState(): Promise<TrayState>
    getPolicy(): Promise<AutonomyPolicy[]>
    setTier(actionType: string, tier: Tier, locked?: boolean): Promise<void>
    resetTrust(): Promise<void>
    pollNow(): Promise<void>
    getLog(limit?: number): Promise<ActionLogEntry[]>
  }
  memory: {
    getGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>
    getNode(id: string): Promise<{ node: GraphNode; edges: GraphEdge[]; memories: Memory[]; timeline: NodeSignalLink[] } | null>
    deleteNode(id: string): Promise<void>
    deleteEdge(id: string): Promise<void>
    deleteMemory(id: string): Promise<void>
    updateMemory(id: string, update: { content?: string; importance?: number; status?: 'active' | 'superseded' }): Promise<void>
    exportMarkdown(): Promise<{ saved: boolean; path?: string }>
  }
  usage: {
    getSummary(range: UsageRange): Promise<UsageSummary>
    getDaily(range: UsageRange): Promise<UsageDailyPoint[]>
    getBySource(range: UsageRange): Promise<UsageBreakdownRow[]>
    getByModel(range: UsageRange): Promise<UsageBreakdownRow[]>
    getRecent(limit: number, range: UsageRange): Promise<UsageEvent[]>
  }
  update: {
    checkNow(): Promise<void>
    install(): Promise<void>
  }
  on(
    channel:
      | 'routine:run-started'
      | 'routine:run-completed'
      | 'routine:run-message'
      | 'plan:item-message'
      | 'badge:updated'
      | 'navigate:edit-routine'
      | 'ambient:intent-created'
      | 'ambient:intent-updated'
      | 'ambient:tray-state'
      | 'ambient:digest-ready'
      | 'ambient:action-executed'
      | 'update:available'
      | 'update:progress'
      | 'update:downloaded'
      | 'update:error',
    listener: (...args: unknown[]) => void
  ): () => void
}
