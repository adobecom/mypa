// ─── Plan ───────────────────────────────────────────────────────────────────

export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'skipped'
export type PlanItemTiming = 'now' | 'morning' | 'afternoon' | 'evening' | 'anytime'
export type PlanItemSource = 'manual_input' | 'routine_suggestion' | 'ambient_action'

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

/**
 * A work-item (PR, issue, Slack message) that was detected in a routine run's raw output.
 * Snapshot so display works even after the underlying signal is pruned.
 * The `key` field matches graph-node keys (`surface:kind:external_id`) and insight
 * focus-node keys, enabling renderer-side linkage without extra IPC calls.
 */
export interface CoveredEntity {
  /** Graph-node key — e.g. "github:pull_request:482". Matches intent focusNodes[].key. */
  key: string
  surface: string
  kind: string
  external_id: string
  title: string
  url: string
}

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
  /** Work items detected in the run's raw MCP output (populated after digest generation). */
  covered_entities: CoveredEntity[]
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * A write action proposed by the assistant mid-chat.
 * Persisted in intent_chat_threads.metadata and surfaced in the renderer as
 * inline Approve / Dismiss buttons. Writes are never executed directly by the
 * CLI — the user approves them and mypa runs them through callTool in-process,
 * recording trust via the autonomy machinery.
 */
export interface ProposedChatAction {
  surface: IntentSurface
  verb: string
  target: string
  payload: Record<string, unknown>
  tier: Tier
  status: 'pending' | 'executed' | 'dismissed' | 'failed'
  resultText?: string
}

/**
 * In-flight tool-approval request emitted by canUseTool during an active chat stream.
 * Broadcast on 'chat:tool-approval-request'; resolved via chat.resolveToolApproval().
 */
export interface PendingToolApproval {
  streamId: string
  approvalId: string
  toolName: string
  toolInput: Record<string, unknown>
  /** Human-readable label, e.g. "GitHub · add issue comment". */
  displayLabel: string
  /** Input field the user can edit before approving (body/message/text). */
  editableField?: string
  editableValue?: string
}

/**
 * In-flight ask_user question emitted by the tool handler during an active chat stream.
 * Broadcast on 'chat:ask-question'; resolved via chat.answerQuestion().
 */
export interface PendingQuestion {
  streamId: string
  questionId: string
  prompt: string
  options: string[]
  multiSelect?: boolean
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: string
  /** Present when the message carries a proposed write action (Phase 2). */
  action?: ProposedChatAction
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
  /** Stdio command (required for stdio transport, absent for http/sse). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** When false the server is configured but not connected. Defaults to true. */
  enabled?: boolean
  /** Transport type. Defaults to 'stdio' when command is present, 'http' when url is present. */
  transport?: 'stdio' | 'http' | 'sse'
  /** Server URL — required for http and sse transports. */
  url?: string
  /** Additional HTTP headers sent with every request (e.g. Authorization: Bearer …). */
  headers?: Record<string, string>
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
  /** True when the server is intentionally disabled (enabled: false in config). */
  disabled?: boolean
}

export interface DetectedMcpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** 'stdio' | 'http' | 'sse' | 'unknown' */
  type: string
  /** Server URL — present for http/sse entries. */
  url?: string
  /** true for stdio, http, and sse servers (all are now supported transports). */
  supported: boolean
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ClaudeConfig {
  model?: string
  apiKey?: string
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

/**
 * Scope config — defines which external containers mypa is allowed to surface.
 * When a list is provided for a surface and a signal's container is NOT on that
 * list, intents derived from that signal are dropped before reaching the DB, graph,
 * or UI. An absent or empty list for a surface means "no restriction".
 *
 * Keyed by IntentSurface ('github' | 'jira' | 'slack'). Values are arrays of
 * container identifiers — GitHub org names, Jira project keys, or Slack channel IDs.
 * All comparisons are case-insensitive.
 *
 * Populated automatically from check-in conversations, or edited directly in Settings.
 */
export interface ScopeConfig {
  /** Per-surface allowlist of container identifiers. */
  allowed?: Record<string, string[]>
}

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
  checkin?: CheckInConfig
  scope?: ScopeConfig
  repos?: RepoLink[]
}

export const DEFAULT_CONFIG: AppConfig = {
  claude: {},
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
    confidenceFloor: 0.4,
    urgencyFloor: 0.5,
    waitingUrgencyFloor: 0.25,
    synthesisIntervalMs: 60 * 60 * 1000,
    synthesisInitialDelayMs: 75_000,
    dailyBudgetUsd: 2.0
  },
  checkin: {
    scheduleEnabled: false
  },
  repos: []
}

// ─── Code authoring (repo links + work products) ─────────────────────────────

/**
 * Links an external work surface (GitHub repo / Jira project) to a repo already
 * checked out on the local machine, so mypa knows where to run code-authoring work.
 * Registered manually in Settings — mypa never clones a repo on the user's behalf.
 */
export interface RepoLink {
  id: string
  /** Absolute path to the existing local clone. Authoring runs happen in a git
   *  worktree derived from this path — the clone itself is never modified. */
  localPath: string
  /** "owner/name", derived from `git remote get-url origin` when the repo is linked. */
  githubRepo?: string
  /** Jira project keys (e.g. "PROJ") whose tickets map to this repo. */
  jiraProjectKeys: string[]
  /** Branch new worktrees are created from. Defaults to the repo's current default branch. */
  defaultBaseBranch: string
  /** When false, mypa may still comment/label/etc. on items in this repo but will never
   *  propose or run authoring work against it. Defaults to true once linked. */
  authoringEnabled: boolean
  created_at: string
}

// ─── Ambient Intelligence ────────────────────────────────────────────────────

export type IntentSurface = 'github' | 'jira' | 'slack' | 'linear'
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
export type TriggerKind = 'spike' | 'staleness' | 'dependency' | 'threshold' | 'time' | 'directed' | 'routine' | 'waiting' | 'plan_chat'
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

// ─── Work products (authored code, pending ship) ─────────────────────────────
//
// A work product is the durable record of a code-authoring attempt: an isolated
// git worktree + branch, the diff produced there, and its shipping lifecycle.
// One work product per intent (intent.verb === 'author_fix'). See authoring.ts
// and worktree.ts.

export type WorkProductStatus =
  | 'drafting'   // authoring agent is running in the worktree
  | 'ready'      // diff produced, awaiting user review / Ship it
  | 'shipping'   // push + PR + comment + Slack chain in progress
  | 'shipped'    // chain completed successfully
  | 'failed'     // authoring or shipping errored
  | 'abandoned'  // user discarded; worktree pruned

export interface WorkProduct {
  id: string
  intent_id: string
  repo_id: string
  worktree_path: string
  branch: string
  base_branch: string
  status: WorkProductStatus
  /** Model-written summary of what was changed and why. */
  summary: string
  /** Human-readable diffstat, e.g. "3 files changed, 42 insertions(+), 7 deletions(-)". */
  diff_stat: string
  files_changed: string[]
  /** Full unified diff — read on demand from the worktree, not duplicated here at rest
   *  beyond this cached copy used for display after the worktree is pruned. */
  diff: string
  error: string | null
  pr_url: string | null
  created_at: string
  shipped_at: string | null
}

export interface IntentObject {
  type: IntentType
  confidence: number
  urgency: number
  proposed_action: ProposedAction
  rationale: string
  reversibility: IntentReversibility
  required_approval: boolean
  /** Concrete MCP tool calls proposed by agentic deep-enrichment.
   *  When present and non-empty, execution uses this instead of proposed_action.
   *  proposed_action is kept as a display/policy summary derived from actions[0]. */
  actions?: McpActionRef[]
}

export interface Intent {
  id: string
  type: IntentType
  trigger_kind: TriggerKind
  confidence: number
  urgency: number
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
  challenge_reason: string | null
  /** Concrete MCP tool calls from agentic deep-enrichment (see IntentObject.actions). */
  actions?: McpActionRef[]
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
  // "Needs me" relation fields — populated by adapters
  relation: string | null     // review_requested | assigned | mentioned | involved | dm | thread_reply
  directed: boolean           // true when latest non-owner actor acted on an item the owner is responsible for
  last_actor: string | null   // latest comment/event author (fixes actor=original-author blind spot)
  due_at: string | null       // deadline from Jira duedate / GitHub milestone
  // Freshness tracking — set by the DB layer on every poll hit (even unchanged fingerprint)
  last_seen_at: string | null // ISO timestamp of the last adapter poll that returned this signal
}

export type SignalInput = Omit<Signal, 'id' | 'observed_at' | 'processed' | 'last_seen_at'>

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
  urgencyFloor?: number              // intents below this urgency are dropped for spike/dependency/time triggers (default 0.5)
  waitingUrgencyFloor?: number       // lower urgency floor for waiting/staleness triggers — real-but-not-urgent items (default 0.25)
  synthesisIntervalMs?: number       // how often the synthesis heartbeat fires (default 60 min)
  synthesisInitialDelayMs?: number   // delay before the first heartbeat tick after boot (default 75 s)
  // Daily USD spend cap for background deep-enrichment (source 'review'). Once today's
  // total usage cost (all sources) reaches this, deep enrichment is skipped for the rest
  // of the day and falls back to lightweight (Haiku/Sonnet) inference. Set to 0 to disable
  // the cap. Default 2.0.
  dailyBudgetUsd?: number
  // Per-resolution-status cooldown (ms) during which re-surfacing the same work item is suppressed.
  // A newer signal fingerprint (new activity after resolution) breaks through the cooldown.
  // Defaults: dismissed/challenged=7d, executed=3d, failed/expired=1d.
  resolutionCooldownMs?: Partial<Record<'dismissed' | 'challenged' | 'executed' | 'failed' | 'expired', number>>
}

// ─── Check-ins ───────────────────────────────────────────────────────────────

export type CheckInStatus = 'active' | 'extracting' | 'complete' | 'error'

export interface CheckIn {
  id: string
  status: CheckInStatus
  trigger: 'manual' | 'scheduled'
  started_at: string
  completed_at: string | null
  briefing: string
  extraction_summary: string | null
}

export interface CheckInConfig {
  scheduleEnabled: boolean
  schedule?: string
}

export interface CheckInExtractionSummary {
  memoriesAdded: number
  nodesUpdated: number
  edgesAdded: number
  /** Number of scope identifiers auto-derived and added from this check-in. */
  scopeUpdated: number
}

export type MemoryType = 'fact' | 'pattern' | 'preference' | 'status'

/**
 * 'hard' — a standing rule extracted from a check-in that the assistant must
 *           always honor. Hard memories are injected into the trusted system-prompt
 *           directive block, not the advisory context section.
 * 'soft' — a preference or guidance; rendered as "Known facts" context (default).
 */
export type MemoryEnforcement = 'hard' | 'soft'

export interface Memory {
  id: string
  content: string
  type: MemoryType
  enforcement: MemoryEnforcement
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
  | 'checkin_chat'
  | 'checkin_extract'
  | 'inference'
  | 'memory'
  | 'chat'
  | 'suggest'
  | 'review'
  | 'authoring'
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

/** Where the active Claude authentication credential is coming from. */
export type AuthSource = 'apikey' | 'env' | 'cli-login' | 'none'

export interface SetupHealthServer {
  name: string
  connected: boolean
  /** True when the server is intentionally disabled (enabled: false in config). */
  disabled?: boolean
  missingEnvKeys: string[]
  /** Filesystem path problems (missing, not a directory, unresolved tilde, etc.) */
  invalidArgs?: string[]
  oauthProvider?: OAuthProvider
  oauthConnectedAt?: string
  oauthStaleDays?: number
}

export interface SetupHealth {
  /** Active Claude auth source. ok=false means no credentials were detected. */
  auth: { ok: boolean; source: AuthSource }
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
    getItem(itemId: string): Promise<PlanItem | null>
    openInMainWindow(itemId: string): Promise<void>
    /** Approve and execute a pending write action proposed in a plan-item chat message. */
    approveChatAction(itemId: string, messageId: string, editedPayload?: Record<string, unknown>): Promise<ProposedChatAction>
    /** Dismiss a pending write action proposed in a plan-item chat message. */
    dismissChatAction(itemId: string, messageId: string): Promise<ProposedChatAction>
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
    openRunInMainWindow(runId: string): Promise<void>
  }
  config: {
    get(): Promise<AppConfig>
    update(config: Partial<AppConfig>): Promise<AppConfig>
    reconnectMcpServer(name: string): Promise<McpServerStatus>
    reconnectAll(): Promise<McpServerStatus[]>
    getMcpStatus(): Promise<McpServerStatus[]>
    getClaudeKey(): Promise<{ configured: boolean; preview: string | null }>
    setClaudeKey(key: string | null): Promise<void>
    /** Returns graph-derived candidate identifiers for the scope multi-select UI. */
    getScopeCandidates(): Promise<Record<string, string[]>>
  }
  repos: {
    getAll(): Promise<RepoLink[]>
    /** Registers a local repo. Reads `git remote get-url origin` and the current
     *  branch to prefill githubRepo/defaultBaseBranch when not provided. */
    add(localPath: string, jiraProjectKeys: string[]): Promise<RepoLink>
    update(id: string, update: Partial<Omit<RepoLink, 'id' | 'created_at'>>): Promise<RepoLink>
    remove(id: string): Promise<void>
  }
  oauth: {
    startDevice(): Promise<DeviceFlowStart>
    pollDevice(deviceCode: string): Promise<string>
    startPkce(provider: 'notion' | 'linear'): Promise<string>
  }
  setup: {
    checkPrerequisites(): Promise<{ ok: boolean; source: AuthSource }>
    getHealth(): Promise<SetupHealth>
    detectClaudeMcp(): Promise<DetectedMcpServer[]>
    resolveOwnerHandles(): Promise<ResolvedOwnerHandles>
  }
  system: {
    openMainWindow(routineId?: string): Promise<void>
    getBadgeCount(): Promise<number>
    getWindowType(): 'widget' | 'main-window'
    openExternal(url: string): Promise<void>
    factoryReset(): Promise<void>
    /** Open the native OS directory-picker dialog. Returns an array of absolute paths,
     *  or an empty array if the user cancels. Pass multiple=true to allow multi-select. */
    pickDirectory(multiple?: boolean): Promise<string[]>
  }
  ambient: {
    getIntents(): Promise<Intent[]>
    getAllIntents(limit?: number): Promise<Intent[]>
    approve(id: string, payload?: Record<string, unknown>): Promise<Intent>
    dismiss(id: string): Promise<void>
    challenge(id: string, reason: string): Promise<Intent>
    /** Revise the intent's proposal using the existing Chat thread. Returns the updated intent,
     *  whether the proposal was applied (vs. below-floor message-only), and the assistant message. */
    reviseFromChat(id: string): Promise<{ intent: Intent; applied: boolean; message: string } | null>
    /** Send a message in the streaming "Chat about it" thread for an intent. */
    sendChatMessage(id: string, message: string): Promise<void>
    /** Retrieve the "Chat about it" streaming conversation thread for an intent. */
    getChatThread(id: string): Promise<ChatMessage[]>
    /** Cancel an in-progress "Chat about it" stream for an intent. */
    cancelChatStream(id: string): Promise<void>
    /** Approve and execute a pending write action proposed in a chat message. */
    approveChatAction(intentId: string, messageId: string, editedPayload?: Record<string, unknown>): Promise<ProposedChatAction>
    /** Dismiss a pending write action proposed in a chat message. */
    dismissChatAction(intentId: string, messageId: string): Promise<ProposedChatAction>
    getDigest(slot?: DigestSlot): Promise<AmbientDigest>
    getTrayState(): Promise<TrayState>
    getPolicy(): Promise<AutonomyPolicy[]>
    setTier(actionType: string, tier: Tier, locked?: boolean): Promise<void>
    resetTrust(): Promise<void>
    pollNow(): Promise<void>
    getLog(limit?: number): Promise<ActionLogEntry[]>
    /** Start (or resume watching) the code-authoring run for an approved author_fix intent. */
    startAuthoring(intentId: string): Promise<WorkProduct>
    getWorkProduct(intentId: string): Promise<WorkProduct | null>
    /** Push the branch, open the PR, comment on the ticket, and post to Slack. */
    shipWorkProduct(intentId: string): Promise<Intent>
    /** Abandon a work product — prunes the worktree and marks the intent dismissed. */
    discardWorkProduct(intentId: string): Promise<void>
  }
  memory: {
    getGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>
    getNode(id: string): Promise<{ node: GraphNode; edges: GraphEdge[]; memories: Memory[]; timeline: NodeSignalLink[] } | null>
    /** Returns all active (non-superseded) memories, sorted by importance descending. */
    getActive(limit?: number): Promise<Memory[]>
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
  checkin: {
    start(): Promise<CheckIn>
    getActive(): Promise<CheckIn | null>
    getAll(limit?: number): Promise<CheckIn[]>
    getThread(checkinId: string): Promise<ChatMessage[]>
    sendMessage(checkinId: string, message: string): Promise<void>
    end(checkinId: string): Promise<void>
    cancelStream(checkinId: string): Promise<void>
    openInMainWindow(checkinId?: string): Promise<void>
  }
  update: {
    checkNow(): Promise<void>
    install(): Promise<void>
  }
  chat: {
    /** Resolve a pending canUseTool gate. allow=true executes; allow=false denies. */
    resolveToolApproval(approvalId: string, allow: boolean, editedInput?: Record<string, unknown>): Promise<void>
    /** Deliver the user's answer to a pending ask_user question. */
    answerQuestion(questionId: string, answer: string | string[]): Promise<void>
  }
  on(
    channel:
      | 'routine:run-started'
      | 'routine:run-completed'
      | 'routine:run-message'
      | 'routine:user-message'
      | 'plan:item-message'
      | 'plan:user-message'
      | 'plan:item-updated'
      | 'badge:updated'
      | 'navigate:edit-routine'
      | 'navigate:run-chat'
      | 'navigate:plan-item'
      | 'ambient:intent-created'
      | 'ambient:intent-updated'
      | 'ambient:tray-state'
      | 'ambient:digest-ready'
      | 'ambient:action-executed'
      | 'ambient:work-product-updated'
      | 'ambient:chat-message'
      | 'ambient:chat-user-message'
      | 'checkin:started'
      | 'checkin:message'
      | 'checkin:status-changed'
      | 'navigate:checkin'
      | 'update:available'
      | 'update:progress'
      | 'update:downloaded'
      | 'update:error'
      | 'chat:tool-approval-request'
      | 'chat:ask-question',
    listener: (...args: unknown[]) => void
  ): () => void
}
