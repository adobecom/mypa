import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { app } from 'electron'
import { existsSync } from 'fs'
import path from 'path'
import { recordUsage } from './usage'
import { selectModel, escalate } from './model-router'
import { readConfig, buildOwnerClause } from './config'
import { buildAgentEnv } from './auth'
import { broadcast } from '../windows'
import { ensureServersConnected, getServerStatus } from './mcp'
import { buildBridgedMcpServers } from './mcp-bridge'
import { logError } from './logger'
import type { UsageSource, ChatMessage, PendingToolApproval, PendingQuestion } from '@shared/types'

// Inter-chunk idle timeout once the stream is producing output.
const STREAM_IDLE_TIMEOUT_MS = 120_000
// Extended timeout for the initial phase (before first SDK message) and for individual
// MCP tool-call round-trips. Must stay below the renderer's 150s safety backstop.
const STREAM_STARTUP_TIMEOUT_MS = 140_000
// Absolute cap on how long a single human-in-the-loop wait (tool approval or ask_user
// question) can hold a stream open. Without this, a card the user dismisses without
// clicking Stop — or two concurrent write-tool approvals colliding on the single-slot
// pendingApprovalCancels/pendingQuestionCancels registries — would leak the CLI
// subprocess for the life of the app instead of eventually self-terminating.
const HUMAN_WAIT_HARD_CAP_MS = 30 * 60_000

/**
 * Serializes async steps that each begin with something the user must see (an approval
 * card or question chip), so a second call queued behind a first never broadcasts its
 * own card until the first has fully resolved. Without this, the SDK yielding two
 * tool_use blocks needing approval close together on one stream (parallel tool calls
 * in a single turn, or rapid retries) can broadcast two 'chat:tool-approval-request'
 * events before the first is answered — the renderer's single-slot pendingToolApproval
 * state (and the backend's single-slot pendingApprovalCancels/pendingQuestionCancels
 * registries, keyed by streamId) silently clobber the earlier one, whose promise then
 * never resolves and hangs the stream until HUMAN_WAIT_HARD_CAP_MS.
 */
function makeSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const started = tail.then(fn, fn)
    tail = started.then(() => undefined, () => undefined)
    return started
  }
}

// In a packaged Electron app the SDK's sdk.mjs lives inside app.asar, so it
// resolves the platform binary to a path that includes app.asar — a file, not
// a directory — causing `spawn ENOTDIR`.  The binary itself is asarUnpack'd
// (see `asarUnpack` in package.json), so we compute its real path and pass it
// via pathToClaudeCodeExecutable to short-circuit the SDK's broken default.
let cachedClaudeExe: string | null | undefined
function resolveClaudeExecutable(): string | undefined {
  if (cachedClaudeExe !== undefined) return cachedClaudeExe ?? undefined
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  // app.getAppPath() → .../app.asar when packaged, project root in dev.
  const base = app.isPackaged
    ? app.getAppPath().replace('app.asar', 'app.asar.unpacked')
    : app.getAppPath()
  const candidate = path.join(base, 'node_modules', '@anthropic-ai', pkg, binName)
  cachedClaudeExe = existsSync(candidate) ? candidate : null
  return cachedClaudeExe ?? undefined
}

interface ActiveAgentChat {
  q: Query
  interrupted: boolean
}

const activeAgentChats = new Map<string, ActiveAgentChat>()

// Pending canUseTool approval requests, keyed by approvalId
const pendingToolApprovals = new Map<string, (allow: boolean, editedInput?: Record<string, unknown>) => void>()
// Cancel functions for in-flight approval prompts, keyed by streamId
const pendingApprovalCancels = new Map<string, () => void>()
// Pending ask_user question answers, keyed by questionId
const pendingQuestions = new Map<string, (answer: string | string[]) => void>()
// Cancel functions for in-flight questions, keyed by streamId
const pendingQuestionCancels = new Map<string, () => void>()

/** Resolve a pending canUseTool gate from the renderer side. */
export function resolveToolApproval(
  approvalId: string,
  allow: boolean,
  editedInput?: Record<string, unknown>,
): void {
  const resolve = pendingToolApprovals.get(approvalId)
  if (resolve) {
    pendingToolApprovals.delete(approvalId)
    resolve(allow, editedInput)
  }
}

/** Deliver a user answer to a pending ask_user question. */
export function resolveQuestion(questionId: string, answer: string | string[]): void {
  const resolve = pendingQuestions.get(questionId)
  if (resolve) {
    pendingQuestions.delete(questionId)
    resolve(answer)
  }
}

/**
 * Build the in-process MCP server that exposes ask_user for this stream.
 * `hooks.begin`/`hooks.end` mark the wait for the user's answer as a human-in-the-loop
 * wait so the caller's idle timer re-arms instead of aborting a legitimately slow reply.
 * `hooks.serialize` queues this question behind any earlier still-unresolved question or
 * approval on the same stream, so a broadcast never clobbers a card the user hasn't
 * answered yet (see `makeSerialQueue`). `hooks.isStopped` short-circuits a queued question
 * that was waiting behind one just cancelled via Stop, so it doesn't flash a stray chip.
 */
function buildAskUserServer(
  streamId: string,
  hooks: {
    begin: () => void
    end: () => void
    serialize: <T>(fn: () => Promise<T>) => Promise<T>
    isStopped: () => boolean
  },
) {
  const askUserTool = tool(
    'ask_user',
    'Ask the user to select from a list of options. Use this whenever you need the user to make a choice — never list options as bullet points and never fabricate a selection.',
    {
      prompt: z.string().describe('The question to present to the user'),
      options: z.array(z.string()).min(2).max(6).describe('The available choices (2–6 items)'),
      multiSelect: z.boolean().optional().describe('Allow the user to select multiple options'),
    },
    async (args) => hooks.serialize(async () => {
      if (hooks.isStopped()) return { content: [{ type: 'text' as const, text: '' }] }

      const questionId = crypto.randomUUID()
      const question: PendingQuestion = {
        streamId,
        questionId,
        prompt: args.prompt,
        options: args.options,
        multiSelect: args.multiSelect ?? false,
      }
      let cancelFn: (() => void) | undefined
      const answerPromise = new Promise<string | string[]>((resolve) => {
        pendingQuestions.set(questionId, (ans) => resolve(ans))
        cancelFn = () => { pendingQuestions.delete(questionId); resolve(args.options[0]) }
      })
      pendingQuestionCancels.set(streamId, () => cancelFn?.())
      broadcast('chat:ask-question', question)
      hooks.begin()
      let answer: string | string[]
      try {
        answer = await answerPromise
      } finally {
        hooks.end()
      }
      pendingQuestions.delete(questionId)
      pendingQuestionCancels.delete(streamId)
      const text = Array.isArray(answer) ? answer.join(', ') : answer
      return { content: [{ type: 'text' as const, text }] }
    }),
    { alwaysLoad: true },
  )
  return createSdkMcpServer({ name: 'mypa_builtin', tools: [askUserTool], alwaysLoad: true })
}

const READ_ONLY_PREFIXES = [
  'get', 'list', 'search', 'read', 'fetch', 'view', 'find',
  'show', 'describe', 'query', 'lookup', 'check',
]

// Secondary guard: if any of these words appear as a standalone component in the
// tool name (after the first), treat the tool as a write operation regardless of
// the read prefix. Prevents tools like fetch_and_update or get_or_create from
// slipping through because they start with a read prefix.
const WRITE_WORDS = new Set([
  'create', 'update', 'delete', 'remove', 'write', 'post', 'put', 'patch',
  'send', 'push', 'add', 'insert', 'modify', 'set', 'edit', 'submit',
])

// Explicit read-only overrides for MCP tool names that contain no read-verb
// component and would otherwise be misclassified as writes by the prefix heuristic.
// Slack's core read tools are the canonical example: conversations_history,
// conversations_replies, conversations_unreads have no "get/list/search/..." word.
// IMPORTANT: entries here bypass the WRITE_WORDS secondary guard entirely —
// only add a tool name if you have verified it performs no server-side mutations.
const READ_ONLY_TOOL_NAMES = new Set([
  'conversations_history',
  'conversations_replies',
  'conversations_unreads',
])

export function isReadOnlyTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  if (READ_ONLY_TOOL_NAMES.has(lower)) return true
  const words = lower.split('_').filter(Boolean)
  // Require at least one word component to be a read-only prefix.
  // Checking any component (not just the first) allows vendor-prefixed tools like
  // jira_get_issue or workday_search_tasks to be recognised as read-only.
  if (!words.some((w) => READ_ONLY_PREFIXES.includes(w))) return false
  // Secondary guard: deny if any non-first component is an explicit write word.
  // This blocks hybrid names like get_or_create or fetch_and_update.
  return !words.slice(1).some((w) => WRITE_WORDS.has(w))
}

function buildPendingToolApproval(
  approvalId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  streamId: string,
): PendingToolApproval {
  // toolName format from SDK: 'mcp__<server>__<tool>' or just '<tool>'
  const parts = toolName.split('__')
  const serverName = parts.length >= 2 ? parts[1] : ''
  const baseTool = parts.length >= 3 ? parts.slice(2).join('__') : toolName
  const displayLabel = [
    serverName && serverName.charAt(0).toUpperCase() + serverName.slice(1),
    baseTool.replace(/_/g, ' '),
  ].filter(Boolean).join(' · ')

  const editableField = ['body', 'message', 'text', 'comment'].find(
    (k) => typeof toolInput[k] === 'string',
  )

  return {
    streamId,
    approvalId,
    toolName,
    toolInput,
    displayLabel,
    editableField,
    editableValue: editableField ? String(toolInput[editableField]) : undefined,
  }
}

/**
 * One-shot Claude call via the Agent SDK, with automatic model selection and
 * failure escalation — drop-in replacement for runClaude() in claude.ts.
 *
 * Uses options.systemPrompt (properly separated from the user turn), replaces
 * the Claude Code default system prompt with the caller's persona prompt,
 * and denies all tool calls so the call stays a pure text generation.
 */
export async function runAgent(
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource = 'other',
  timeoutMs = 120_000,
  expectJson = false
): Promise<string> {
  let model = selectModel(source, systemPrompt.length + userPrompt.length)
  while (true) {
    try {
      return await runAgentOnce(model, systemPrompt, userPrompt, source, timeoutMs, expectJson)
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'Agent timed out') throw err
      const next = escalate(model)
      if (!next) throw err
      console.log(`[agent] escalating ${model} → ${next} (${source}): ${msg}`)
      model = next
    }
  }
}

async function runAgentOnce(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource,
  timeoutMs: number,
  expectJson: boolean,
  isJsonRetry = false
): Promise<string> {
  const ac = new AbortController()
  // Dedicated flag — avoids the race where ac.abort() fires just before clearTimeout
  // and ac.signal.aborted would give a false positive after the loop already completed.
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)

  let text = ''
  let resultMsg: SDKResultMessage | null = null

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model,
        // Remove all built-in tools from context — this is a pure text-generation call.
        // With an empty tool set the model cannot attempt (and waste turns on denied)
        // built-in tool calls, so a single turn is sufficient and reliable.
        tools: [],
        maxTurns: 1,
        permissionMode: 'default',
        // Defense-in-depth: deny any tool that somehow slips through.
        canUseTool: async () => ({ behavior: 'deny', message: 'one-shot mode — no tools' }),
        abortController: ac,
        env: buildAgentEnv(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      }
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text') text += block.text
        }
      }
      if (msg.type === 'result') {
        resultMsg = msg
      }
    }
  } catch (err) {
    clearTimeout(timer)
    if (timedOut) throw new Error('Agent timed out')
    throw err
  }

  clearTimeout(timer)
  // Do not check timedOut here: if the loop exited cleanly we have a valid response
  // even if the timer fired in the final moments. Only the catch path (SDK threw due
  // to the abort signal) should surface as a timeout error.

  if (!resultMsg) {
    console.warn('[agent] SDK completed without emitting a result message — usage not recorded')
    throw new Error('Agent returned no result message')
  }

  recordSdkUsage(source, model, resultMsg)

  if (resultMsg.is_error) {
    throw new Error(
      typeof (resultMsg as any).result === 'string'
        ? (resultMsg as any).result
        : 'Agent returned an error'
    )
  }

  // Fallback: if no assistant text blocks were emitted, use the result field.
  // Intentionally excludes JSON strings (startsWith { or [) — those indicate the
  // model put its response in the result envelope rather than an assistant block,
  // which triggers expectJson escalation just as the old CLI path did.
  if (!text) {
    const r = typeof (resultMsg as any).result === 'string' ? (resultMsg as any).result as string : ''
    if (r && !r.startsWith('{') && !r.startsWith('[')) text = r
  }

  if (expectJson && !text.includes('{') && !text.includes('[')) {
    // Before climbing to a stronger (pricier) tier, give this same tier one more
    // chance with an explicit format instruction — most weak-JSON failures are a
    // formatting slip, not a capability gap, and a same-tier retry is far cheaper
    // than an escalation.
    if (!isJsonRetry) {
      console.log(`[agent] non-JSON response from ${model} (${source}) — retrying same tier with stricter format instruction`)
      // Capped, not the full timeoutMs — this is a quick reformat nudge, not a
      // fresh attempt at the task, so it shouldn't double the worst-case latency
      // a caller budgeted for.
      return runAgentOnce(
        model,
        systemPrompt,
        `${userPrompt}\n\nReturn ONLY raw JSON — no prose, no markdown code fences, no explanation.`,
        source,
        Math.min(timeoutMs, 30_000),
        expectJson,
        true
      )
    }
    throw new Error('Agent returned non-JSON response when JSON was expected')
  }

  return text
}

function recordSdkUsage(source: UsageSource, model: string, result: SDKResultMessage): void {
  const u = (result as any).usage ?? {}
  recordUsage(source, model, {
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    },
    total_cost_usd: (result as any).total_cost_usd ?? 0,
  })
}

// ─── Streaming chat ───────────────────────────────────────────────────────────

export function cancelAgentChat(streamId: string): boolean {
  // Cancel any pending tool approval so canUseTool can return and the generator can exit
  const cancelApproval = pendingApprovalCancels.get(streamId)
  if (cancelApproval) {
    cancelApproval()
    pendingApprovalCancels.delete(streamId)
  }
  // Cancel any pending ask_user question
  const cancelQuestion = pendingQuestionCancels.get(streamId)
  if (cancelQuestion) {
    cancelQuestion()
    pendingQuestionCancels.delete(streamId)
  }
  const entry = activeAgentChats.get(streamId)
  if (!entry) return !!(cancelApproval || cancelQuestion)
  entry.interrupted = true
  activeAgentChats.delete(streamId)
  entry.q.interrupt().catch(() => {})
  return true
}

export async function streamAgentChat(
  history: ChatMessage[],
  userMessage: string,
  onChunk: (chunk: string) => void,
  onDone: (fullText: string) => void,
  rawContext?: string,
  streamId?: string,
  source: UsageSource = 'chat',
  enableMcp = false,
  onStatus?: (status: string) => void,
): Promise<void> {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  const cfg = readConfig()
  const persona = cfg.persona?.trim() || 'a personal assistant'
  const ownerClause = buildOwnerClause()
  const askUserGuidance = 'When you need the user to choose between options, always call the ask_user tool — never list options as bullet points and never select an answer yourself.'
  const contextGuidance = rawContext
    ? ' Basic metadata (URLs, IDs, titles, authors) is already in the data below — read it from there rather than fetching it again. Use tools to retrieve additional details not already present (e.g. PR diff, file contents, comments, full ticket body).'
    : ''
  const systemPrompt = rawContext
    ? `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented. ${askUserGuidance}${contextGuidance}\n\nOriginal data collected:\n${rawContext}`
    : `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented. ${askUserGuidance}`

  // Source MCP servers from the warm connection pool as in-process proxies.
  // ensureServersConnected() does a best-effort reconnect of any pool entry that has
  // gone dead since boot (without blocking the stream if reconnect fails), then
  // buildBridgedMcpServers() wraps each connected server in a lightweight Server that
  // serves tools/list and tools/call in-process — zero subprocess spawns, zero cold-boot.
  // Disconnected or disabled servers are simply absent from the map (fast, honest).
  if (enableMcp) {
    await ensureServersConnected()
  }
  const sdkMcpServers = enableMcp ? buildBridgedMcpServers() : {}

  // When MCP is on but some configured servers failed to connect, prepend an explicit
  // note so the model reports the outage rather than confabulating tool results.
  // Two failure modes are addressed:
  //  1. Silent omission: servers absent from the tool list with no explanation cause
  //     the model to invent detailed false root causes (ZodErrors, schema mismatches,
  //     session bugs, etc.).
  //  2. History contamination: if a prior turn in this conversation contains a
  //     hallucinated diagnostic about why tools are blocked, the model will echo it
  //     as a "confirmed" finding. The note must explicitly override prior assertions,
  //     not just append a fact the model may discount against its own context.
  // Prepended (not appended) so it sits in the highest-priority region of the system
  // prompt and is less likely to be overridden by the conversation history.
  let effectiveSystemPrompt = systemPrompt
  if (enableMcp) {
    const statuses = getServerStatus()
    const unavailable = statuses.filter((s) => !s.connected && s.disabled !== true)
    if (unavailable.length > 0) {
      const detail = unavailable
        .map((s) => (s.error ? `${s.name} (${s.error})` : s.name))
        .join(', ')
      const unavailabilityNote =
        `IMPORTANT — current tool status (authoritative; overrides any prior claims in this conversation): ` +
        `The following MCP servers are configured but unavailable right now due to a connection failure: ${detail}. ` +
        `Do NOT attempt to call tools from these servers. Do NOT claim to have retrieved data from them. ` +
        `If this conversation history contains prior diagnostic claims about these tools ` +
        `(e.g. permission errors, schema validation errors, session bugs, ZodErrors, token issues) — ` +
        `those assertions were incorrect. The actual cause is a connection failure, not an app bug. ` +
        `Tell the user the server is unavailable and cannot connect.\n\n`
      effectiveSystemPrompt = unavailabilityNote + systemPrompt
    }
  }

  const approxLen = effectiveSystemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0)
  let model = selectModel(source, approxLen)

  while (true) {
    try {
      const full = await streamAgentChatOnce(
        model, effectiveSystemPrompt, messages, onChunk, streamId, source,
        Object.keys(sdkMcpServers).length > 0 ? sdkMcpServers : undefined,
        onStatus,
      )
      onDone(full)
      return
    } catch (err) {
      // Never escalate timeouts or user-initiated cancellations — only true model errors.
      if ((err as Error).message === 'Cancelled' || (err as Error & { noEscalate?: boolean }).noEscalate) throw err
      const next = escalate(model)
      if (!next) throw err
      console.log(`[agent] stream: escalating ${model} → ${next} (${source})`)
      model = next
    }
  }
}

async function streamAgentChatOnce(
  model: string,
  systemPrompt: string,
  messages: { role: string; content: string }[],
  onChunk: (chunk: string) => void,
  streamId: string | undefined,
  source: UsageSource,
  mcpServers?: Record<string, unknown>,
  onStatus?: (status: string) => void,
): Promise<string> {
  // Format conversation as a flat prompt — mirrors the CLI's -p approach.
  const prompt = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')

  const ac = new AbortController()
  let timedOut = false
  // Set once this call's loop has exited (success or error) so any human-wait
  // `finally` that resolves afterward (e.g. a cancelFn drained during teardown,
  // whose continuation runs as a later microtask) can't re-arm a timer that
  // nothing will ever clear again.
  let stopped = false

  // A write-tool approval (canUseTool) or an ask_user question blocks on a human
  // response, during which the SDK yields no messages — so nothing would otherwise
  // reset the idle timer. humanWaits counts outstanding human-in-the-loop waits;
  // while it's > 0, the idle timer re-arms itself instead of aborting the stream,
  // so a slow human doesn't get mistaken for a stalled model/tool. humanWaitStartedAt
  // bounds this with an absolute cap (HUMAN_WAIT_HARD_CAP_MS) so a wait nobody ever
  // resolves — dismissed without Stop — still eventually aborts.
  let humanWaits = 0
  let humanWaitStartedAt = 0
  const beginHumanWait = (): void => {
    if (humanWaits === 0) humanWaitStartedAt = Date.now()
    humanWaits++
  }
  const endHumanWait = (): void => {
    humanWaits = Math.max(0, humanWaits - 1)
    if (humanWaits === 0) humanWaitStartedAt = 0
    if (!stopped) resetIdle()
  }

  // Approvals and questions are each serialized (see makeSerialQueue) so a second
  // one on the same stream is never broadcast until the first has fully resolved —
  // otherwise it would silently clobber the renderer's single-slot pending state and
  // the single-slot pendingApprovalCancels/pendingQuestionCancels registries below.
  const runApprovalTurn = makeSerialQueue()
  const runQuestionTurn = makeSerialQueue()

  const onIdleFire = (): void => {
    if (stopped) return
    if (humanWaits > 0 && Date.now() - humanWaitStartedAt < HUMAN_WAIT_HARD_CAP_MS) {
      idleTimer = setTimeout(onIdleFire, STREAM_STARTUP_TIMEOUT_MS)
      return
    }
    timedOut = true
    ac.abort()
  }

  // Always attach the ask_user in-process server so the model can ask questions
  const allMcpServers: Record<string, any> = { ...(mcpServers ?? {}) }  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (streamId) {
    allMcpServers['mypa_builtin'] = buildAskUserServer(streamId, {
      begin: beginHumanWait,
      end: endHumanWait,
      serialize: runQuestionTurn,
      isStopped: () => stopped || entry.interrupted,
    })
  }
  const hasMcp = Object.keys(allMcpServers).length > 0

  // Use the extended startup budget for the first message when MCP is on, to cover
  // in-process bridge setup and any initial tool calls. Once a message lands,
  // resetIdle() re-arms at the tighter inter-chunk value.
  const firstTimeout = hasMcp ? STREAM_STARTUP_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS
  let idleTimer = setTimeout(onIdleFire, firstTimeout)

  const resetIdle = (ms = STREAM_IDLE_TIMEOUT_MS): void => {
    clearTimeout(idleTimer)
    if (stopped) return
    idleTimer = setTimeout(onIdleFire, ms)
  }

  // Phase tracking and heartbeat: emit onStatus immediately on the initial phase, then
  // every 8s so the renderer's 150s safety backstop keeps resetting during long silent
  // waits (bridge connect, tool execution). Cleared as soon as the first text chunk
  // arrives (real chunks reset the backstop directly) or on any exit path.
  let receivedFirstMessage = false
  let phase = hasMcp ? 'Connecting to tools…' : 'Working…'
  let heartbeat: ReturnType<typeof setInterval> | null = null
  if (onStatus) {
    onStatus(phase)
    heartbeat = setInterval(() => { if (onStatus) onStatus(phase) }, 8_000)
  }

  const q = query({
    prompt,
    options: {
      systemPrompt,
      model,
      // Remove all built-in tools (Bash, Edit, Write, etc.) — chat sessions use
      // MCP tools and the in-process ask_user tool only. tools: [] does not affect
      // MCP servers supplied via the mcpServers option.
      tools: [],
      maxTurns: hasMcp ? 10 : 1,
      permissionMode: 'default',
      ...(hasMcp ? { mcpServers: allMcpServers } : {}),
      env: buildAgentEnv(),
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      canUseTool: async (toolName: string, toolInput: unknown) => {
        // Extract the base tool name after the mcp__server__ prefix
        const parts = toolName.split('__')
        const serverName = parts.length >= 2 ? parts[1] : ''
        const baseName = parts.length >= 3 ? parts.slice(2).join('__') : toolName
        // The CLI binary's runtime Zod schema requires updatedInput to be a record
        // on allow responses (stricter than the .d.ts types which mark it optional).
        // Always echo the original input back so the allow branch validates.
        const inputRecord = (toolInput as Record<string, unknown>) ?? {}

        // Always allow our own built-in tools (ask_user etc.)
        if (serverName === 'mypa_builtin') return { behavior: 'allow', updatedInput: inputRecord }

        if (isReadOnlyTool(baseName)) return { behavior: 'allow', updatedInput: inputRecord }

        // Defense-in-depth: only genuine MCP write tools (mcp__server__tool format,
        // i.e. parts.length >= 3) may enter the user-approval flow. A bare built-in
        // tool name (e.g. "Bash") reaching here would await an approval card that the
        // renderer cannot surface, hanging the stream indefinitely. Deny it cleanly.
        if (parts.length < 3) {
          return { behavior: 'deny', message: 'Built-in tools are not available in chat sessions' }
        }

        if (!mcpServers || !streamId) {
          return { behavior: 'deny', message: 'Write tools require an active MCP-enabled chat session' }
        }

        // Gate write tools via user approval — serialized so a second write-tool
        // call queued behind this one never broadcasts its own card until this one
        // has fully resolved (see makeSerialQueue / runApprovalTurn above).
        return runApprovalTurn(async () => {
          if (stopped || entry.interrupted) {
            return { behavior: 'deny', message: 'Stream cancelled' } as const
          }

          const approvalId = crypto.randomUUID()
          const approval = buildPendingToolApproval(
            approvalId, toolName, inputRecord, streamId,
          )
          let cancelFn: (() => void) | undefined
          const resultPromise = new Promise<{ allow: boolean; editedInput?: Record<string, unknown> }>(
            (resolve) => {
              pendingToolApprovals.set(approvalId, (a, ei) => resolve({ allow: a, editedInput: ei }))
              cancelFn = () => { pendingToolApprovals.delete(approvalId); resolve({ allow: false }) }
            },
          )
          pendingApprovalCancels.set(streamId, () => cancelFn?.())
          broadcast('chat:tool-approval-request', approval)
          beginHumanWait()
          let allow: boolean, editedInput: Record<string, unknown> | undefined
          try {
            ({ allow, editedInput } = await resultPromise)
          } finally {
            endHumanWait()
          }
          pendingToolApprovals.delete(approvalId)
          pendingApprovalCancels.delete(streamId)
          if (!allow) return { behavior: 'deny', message: 'Dismissed by user' }
          return { behavior: 'allow', updatedInput: editedInput ?? inputRecord }
        })
      },
      abortController: ac,
    },
  })

  const entry: ActiveAgentChat = { q, interrupted: false }
  if (streamId) activeAgentChats.set(streamId, entry)

  let full = ''
  let resultMsg: SDKResultMessage | null = null
  let hasText = false

  try {
    for await (const msg of q) {
      resetIdle()
      // Mark first SDK message received and transition the phase label out of startup.
      if (!receivedFirstMessage) {
        receivedFirstMessage = true
        phase = 'Working…'
        if (onStatus) onStatus(phase)
      }
      if (msg.type === 'assistant') {
        // When the model emits a tool call the SDK silently awaits the MCP server
        // response before yielding the next message. Give that wait the extended
        // startup budget so a slow tool round-trip does not trigger the idle timer.
        // Note: MCP tools use type 'mcp_tool_use', not 'tool_use'.
        if ((msg.message?.content ?? []).some(
          (b: any) => b.type === 'tool_use' || b.type === 'mcp_tool_use',
        )) {
          resetIdle(STREAM_STARTUP_TIMEOUT_MS)
          // Emit a "Using {server}…" status so the user sees which MCP server is active.
          // Tool names follow the mcp__{server}__{tool} convention.
          if (onStatus) {
            const toolBlocks: any[] = (msg.message?.content ?? []).filter(  // eslint-disable-line @typescript-eslint/no-explicit-any
              (b: any) => b.type === 'tool_use' || b.type === 'mcp_tool_use',
            )
            const toolName: string = toolBlocks[0]?.name ?? ''
            const nameParts = toolName.split('__')
            const serverLabel = nameParts.length >= 2 ? nameParts[1] : toolName
            // Don't show "Using mypa_builtin…" — ask_user is an invisible in-process
            // tool; the rendered question chip is already sufficient user feedback.
            if (serverLabel !== 'mypa_builtin') {
              phase = `Using ${serverLabel}…`
              onStatus(phase)
            }
          }
        }
        const textBlocks = (msg.message?.content ?? []).filter(
          (b: any) => b.type === 'text' && typeof b.text === 'string' && b.text,
        )
        if (textBlocks.length > 0) {
          // Stop the heartbeat — real text chunks will reset the renderer backstop directly.
          if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null }
          if (hasText) onChunk('\x00SPLIT\x00')
        }
        for (const block of textBlocks as any[]) {
          full += block.text
          hasText = true
          onChunk(block.text)
        }
      }
      if (msg.type === 'result') resultMsg = msg
      // tool_progress is a periodic heartbeat emitted by the SDK while a tool runs.
      // Re-arm with the startup budget so gaps between heartbeats don't trigger a timeout.
      if (msg.type === 'tool_progress') resetIdle(STREAM_STARTUP_TIMEOUT_MS)
      // Capture tool-result errors so the real failure appears in ~/.mypa/mypa.log
      // rather than only in the model's narrative (which may confabulate a cause).
      if (msg.type === 'user') {
        const userContent: unknown[] = (msg as any).message?.content ?? []  // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const block of userContent) {
          const b = block as Record<string, unknown>
          if (b.type === 'tool_result' && b.is_error) {
            const toolUseId = String(b.tool_use_id ?? '')
            const text = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
              ? (b.content as Array<Record<string, unknown>>)
                  .filter((c) => c.type === 'text')
                  .map((c) => String(c.text ?? ''))
                  .join('\n')
              : JSON.stringify(b.content)
            logError('agent', `tool_result error (tool_use_id=${toolUseId}): ${text}`)
          }
        }
      }
    }
  } catch (err) {
    stopped = true
    clearTimeout(idleTimer)
    if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null }
    if (streamId) activeAgentChats.delete(streamId)
    // Drain any pending approval/question promises so they don't leak on unexpected errors.
    if (streamId) {
      const cancelApproval = pendingApprovalCancels.get(streamId)
      if (cancelApproval) { cancelApproval(); pendingApprovalCancels.delete(streamId) }
      const cancelQuestion = pendingQuestionCancels.get(streamId)
      if (cancelQuestion) { cancelQuestion(); pendingQuestionCancels.delete(streamId) }
    }
    if (timedOut) {
      // Emit a specific, actionable message depending on how far the stream had progressed.
      const timeoutMsg = receivedFirstMessage
        ? 'The assistant stopped mid-response. Please try again.'
        : 'Timed out starting up tools. Check that your MCP servers are reachable, then try again.'
      const timeoutErr = new Error(timeoutMsg) as Error & { noEscalate: boolean }
      timeoutErr.noEscalate = true  // Do not escalate to a larger model — this is an infra issue.
      throw timeoutErr
    }
    if (entry.interrupted) throw new Error('Cancelled')
    throw err
  }

  stopped = true
  clearTimeout(idleTimer)
  if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null }
  if (streamId) activeAgentChats.delete(streamId)
  // Do not check timedOut here: a clean loop exit means we have a complete response.
  if (entry.interrupted) throw new Error('Cancelled')

  if (resultMsg) {
    recordSdkUsage(source, model, resultMsg)
    if (resultMsg.is_error) {
      throw new Error(
        typeof (resultMsg as any).result === 'string'
          ? (resultMsg as any).result
          : 'Agent returned an error',
      )
    }
  }

  if (!full && resultMsg) {
    const r = typeof (resultMsg as any).result === 'string' ? (resultMsg as any).result as string : ''
    if (r && !r.startsWith('{') && !r.startsWith('[')) {
      full = r
      // Don't onChunk here — onDone(full) in the outer loop delivers it atomically,
      // avoiding a double-send if this attempt is later superseded by escalation.
    }
  }

  return full
}

// ─── One-shot with MCP reads ──────────────────────────────────────────────────

/**
 * One-shot call with native MCP read-only tools available.
 * Replaces runClaudeWithMcp() — write tools are always denied; only
 * tools whose name starts with a read-only prefix are allowed.
 */
export async function runAgentWithMcp(
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource = 'suggest',
  timeoutMs = 180_000,
): Promise<string> {
  const cfg = readConfig()
  const sdkMcpServers: Record<string, { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }> = {}
  for (const srv of cfg.mcp_servers) {
    if (!srv.command) continue
    const safeName = srv.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    sdkMcpServers[safeName] = {
      type: 'stdio',
      command: srv.command,
      ...(srv.args?.length ? { args: srv.args } : {}),
      ...(Object.keys(srv.env ?? {}).length ? { env: srv.env } : {}),
    }
  }
  if (Object.keys(sdkMcpServers).length === 0) {
    return runAgent(systemPrompt, userPrompt, source, timeoutMs)
  }

  let model = selectModel(source, systemPrompt.length + userPrompt.length)
  while (true) {
    try {
      return await runAgentWithMcpOnce(model, systemPrompt, userPrompt, source, timeoutMs, sdkMcpServers)
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'Agent timed out') throw err
      const next = escalate(model)
      if (!next) throw err
      console.log(`[agent] MCP escalating ${model} → ${next} (${source}): ${msg}`)
      model = next
    }
  }
}

// ─── Agentic scheduled routine runs ──────────────────────────────────────────

export interface RoutineAgentFailure {
  server: string
  tool: string
  message: string
}

export interface RoutineAgentResult {
  text: string
  rawOutput: string
  successCount: number
  failures: RoutineAgentFailure[]
}

/**
 * Agentic MCP run for a scheduled routine. Like runAgentWithMcp, but instead of
 * returning only the final narrative, it also captures every tool_result block
 * (success and error) from the SDK message stream — this stands in for the old
 * static callTool loop in executeRoutine, giving routines.ts the same
 * rawOutput/failures shape it used to build from directly-invoked MCP calls,
 * while letting the model chain tool calls (e.g. list_pull_requests →
 * get_pull_request_status) with real IDs instead of frozen placeholder params.
 *
 * Read-only only: canUseTool denies every write tool, so an unattended scheduled
 * run can never block on (or silently skip) an approval prompt.
 *
 * MCP servers are sourced from the warm connection pool via ensureServersConnected()
 * + buildBridgedMcpServers() — the same in-process bridge streamAgentChat uses —
 * rather than cold-spawning a fresh stdio subprocess per run. A routine can fire
 * many times a day; cold-spawning would pay process-start + handshake latency (and
 * risk a second, redundant connection to a server the pool already holds open) on
 * every tick, and would ignore each server's enabled/disabled flag (the pool
 * already excludes disabled servers).
 */
export async function runRoutineAgent(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 300_000,
): Promise<RoutineAgentResult> {
  await ensureServersConnected()
  const sdkMcpServers = buildBridgedMcpServers()

  // Mirrors streamAgentChat's unavailability note (see its comment above) — tell the
  // model plainly which configured servers are down rather than letting it silently
  // omit or confabulate results for them.
  let effectiveSystemPrompt = systemPrompt
  const unavailable = getServerStatus().filter((s) => !s.connected && s.disabled !== true)
  if (unavailable.length > 0) {
    const detail = unavailable.map((s) => (s.error ? `${s.name} (${s.error})` : s.name)).join(', ')
    effectiveSystemPrompt =
      `IMPORTANT — the following MCP servers are configured but unavailable right now: ${detail}. ` +
      `Do NOT attempt to call tools from these servers or claim to have retrieved data from them — ` +
      `note the outage plainly in your report instead.\n\n${systemPrompt}`
  }

  let model = selectModel('routine_run', effectiveSystemPrompt.length + userPrompt.length)
  while (true) {
    try {
      return await runRoutineAgentOnce(model, effectiveSystemPrompt, userPrompt, timeoutMs, sdkMcpServers)
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'Agent timed out') throw err
      const next = escalate(model)
      if (!next) throw err
      console.log(`[agent] routine escalating ${model} → ${next}: ${msg}`)
      model = next
    }
  }
}

async function runRoutineAgentOnce(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  // Typed loosely (matching streamAgentChatOnce's mcpServers param) rather than as
  // ReturnType<typeof buildBridgedMcpServers> — the bridge's { type: 'sdk', instance }
  // shape wraps the lower-level MCP `Server` class, while the SDK's own Options type
  // expects the higher-level `McpServer`; the bridge already works correctly with the
  // SDK at runtime (streamAgentChat has used it this way since it was introduced), so
  // this is a type-only mismatch, not a real incompatibility.
  mcpServers: Record<string, unknown>,
): Promise<RoutineAgentResult> {
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)

  let text = ''
  let resultMsg: SDKResultMessage | null = null
  const toolOutputs: string[] = []
  const failures: RoutineAgentFailure[] = []
  // Maps tool_use_id → { server, tool } so a later tool_result (success or error)
  // can be labeled the way the old callTool loop labeled entries: "[server.tool]".
  const toolUseIndex = new Map<string, { server: string; tool: string }>()

  const hasMcp = Object.keys(mcpServers).length > 0
  const allMcpServers: Record<string, any> = { ...mcpServers }  // eslint-disable-line @typescript-eslint/no-explicit-any

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model,
        // Strip built-in tools — scheduled routine runs use MCP tools only.
        tools: [],
        maxTurns: 15,
        permissionMode: 'default',
        ...(hasMcp ? { mcpServers: allMcpServers } : {}),
        env: buildAgentEnv(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        canUseTool: async (toolName: string, toolInput: unknown) => {
          const parts = toolName.split('__')
          const baseName = parts.length >= 3 ? parts.slice(2).join('__') : toolName
          const inputRecord = (toolInput as Record<string, unknown>) ?? {}
          if (isReadOnlyTool(baseName)) return { behavior: 'allow', updatedInput: inputRecord }
          return { behavior: 'deny', message: 'write tools are not available in scheduled routine runs' }
        },
        abortController: ac,
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          const b = block as any // eslint-disable-line @typescript-eslint/no-explicit-any
          if (b.type === 'text') text += b.text
          if (b.type === 'tool_use') {
            const parts = String(b.name ?? '').split('__')
            const server = parts.length >= 2 ? parts[1] : ''
            const tool = parts.length >= 3 ? parts.slice(2).join('__') : String(b.name ?? '')
            if (b.id) toolUseIndex.set(String(b.id), { server, tool })
          }
        }
      }
      if (msg.type === 'result') resultMsg = msg
      if (msg.type === 'user') {
        const userContent: unknown[] = (msg as any).message?.content ?? [] // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const block of userContent) {
          const b = block as Record<string, unknown>
          if (b.type !== 'tool_result') continue
          const toolUseId = String(b.tool_use_id ?? '')
          const ref = toolUseIndex.get(toolUseId) ?? { server: 'unknown', tool: 'unknown' }
          const contentText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
            ? (b.content as Array<Record<string, unknown>>)
                .filter((c) => c.type === 'text')
                .map((c) => String(c.text ?? ''))
                .join('\n')
            // JSON.stringify returns the runtime value undefined (not the string
            // "undefined") when b.content is itself undefined — coalesce so a
            // RoutineAgentFailure.message is never actually undefined at runtime.
            : (JSON.stringify(b.content) ?? '')
          if (b.is_error) {
            logError('agent', `tool_result error (tool_use_id=${toolUseId}): ${contentText}`)
            failures.push({ server: ref.server, tool: ref.tool, message: contentText })
          } else {
            toolOutputs.push(`[${ref.server}.${ref.tool}]\n${contentText}`)
          }
        }
      }
    }
  } catch (err) {
    clearTimeout(timer)
    if (timedOut) throw new Error('Agent timed out')
    throw err
  }

  clearTimeout(timer)
  if (!resultMsg) {
    console.warn('[agent] routine SDK completed without emitting a result message — usage not recorded')
    throw new Error('Agent returned no result message')
  }
  recordSdkUsage('routine_run', model, resultMsg)
  if (resultMsg.is_error) {
    // A run can legitimately end in_error after successfully gathering some data —
    // most commonly hitting maxTurns mid-chain on a long list (the exact "list, then
    // fetch per item" shape this whole path exists for). Discarding everything
    // collected so far in that case would throw away real, already-fetched data over
    // a run that was still substantively productive — return the partial result
    // instead so routines.ts can still build a digest from what was gathered.
    if (toolOutputs.length > 0 || failures.length > 0) {
      return {
        text,
        rawOutput: toolOutputs.join('\n\n---\n\n'),
        successCount: toolOutputs.length,
        failures,
      }
    }
    throw new Error(
      typeof (resultMsg as any).result === 'string'
        ? (resultMsg as any).result
        : 'Agent returned an error',
    )
  }
  if (!text) {
    const r = typeof (resultMsg as any).result === 'string' ? (resultMsg as any).result as string : ''
    if (r && !r.startsWith('{') && !r.startsWith('[')) text = r
  }

  return {
    text,
    rawOutput: toolOutputs.join('\n\n---\n\n'),
    successCount: toolOutputs.length,
    failures,
  }
}

// Internal overload of runAgentOnce that accepts mcpServers
async function runAgentWithMcpOnce(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource,
  timeoutMs: number,
  mcpServers: Record<string, { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }>,
): Promise<string> {
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)

  let text = ''
  let resultMsg: SDKResultMessage | null = null

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model,
        // Strip built-in tools — one-shot MCP reads use MCP tools only (no Bash/Edit/Write).
        tools: [],
        maxTurns: 10,
        permissionMode: 'default',
        mcpServers,
        env: buildAgentEnv(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        canUseTool: async (toolName: string, toolInput: unknown) => {
          const parts = toolName.split('__')
          const baseName = parts.length >= 3 ? parts.slice(2).join('__') : toolName
          const inputRecord = (toolInput as Record<string, unknown>) ?? {}
          if (isReadOnlyTool(baseName)) return { behavior: 'allow', updatedInput: inputRecord }
          return { behavior: 'deny', message: 'write tools not available in one-shot MCP mode' }
        },
        abortController: ac,
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if ((block as any).type === 'text') text += (block as any).text  // eslint-disable-line @typescript-eslint/no-explicit-any
        }
      }
      if (msg.type === 'result') resultMsg = msg
      // Capture tool-result errors so the real failure appears in ~/.mypa/mypa.log
      // rather than only in the model's narrative (which may confabulate a cause).
      if (msg.type === 'user') {
        const userContent: unknown[] = (msg as any).message?.content ?? []  // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const block of userContent) {
          const b = block as Record<string, unknown>
          if (b.type === 'tool_result' && b.is_error) {
            const toolUseId = String(b.tool_use_id ?? '')
            const text2 = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
              ? (b.content as Array<Record<string, unknown>>)
                  .filter((c) => c.type === 'text')
                  .map((c) => String(c.text ?? ''))
                  .join('\n')
              : JSON.stringify(b.content)
            logError('agent', `tool_result error (tool_use_id=${toolUseId}): ${text2}`)
          }
        }
      }
    }
  } catch (err) {
    clearTimeout(timer)
    if (timedOut) throw new Error('Agent timed out')
    throw err
  }

  clearTimeout(timer)
  if (!resultMsg) {
    console.warn('[agent] MCP SDK completed without emitting a result message — usage not recorded')
    throw new Error('Agent returned no result message')
  }
  recordSdkUsage(source, model, resultMsg)
  if (resultMsg.is_error) {
    throw new Error(
      typeof (resultMsg as any).result === 'string'
        ? (resultMsg as any).result
        : 'Agent returned an error',
    )
  }
  if (!text) {
    const r = typeof (resultMsg as any).result === 'string' ? (resultMsg as any).result as string : ''
    if (r && !r.startsWith('{') && !r.startsWith('[')) text = r
  }
  return text
}

// ─── Authoring: agentic code changes in an isolated worktree ─────────────────
//
// This is the ONLY call site in this file that grants built-in file/shell tools
// (Bash, Edit, Read, Write, Grep, Glob). Every other mode above deliberately sets
// tools: [] and/or denies bare built-in tool names outright — that boundary is
// intentional, and this function is meant to be the sole, narrow exception to it.
// Isolation comes from: (1) `cwd` is pinned to a disposable git worktree created by
// worktree.ts, never the user's real checkout; (2) canUseTool below confines
// Edit/Write/Read/Grep/Glob calls to that worktree by path. Bash is NOT path-confined — a
// command can read/write anywhere the OS user can, and the denylist below is a
// best-effort string match on the literal command, not a real sandbox (a command
// that writes a script to a file and then executes it, or otherwise obscures its
// target, is not caught). The real safety property this mode relies on is that it
// only ever runs against a disposable worktree under a user-initiated,
// approve-to-start flow — not that Bash itself is contained.

// Authoring runs are unattended for potentially many tool calls in a row (reading
// files, editing, running local builds/tests) — a single wall-clock deadline for
// the whole run is simpler and safer here than the chat idle-timer pattern above,
// which assumes a human is watching for stalls.
const AUTHORING_TIMEOUT_MS = 15 * 60_000

// Best-effort command denylist — blocks the specific escape hatches that would let
// an authoring run leave its sandbox (pushing/fetching/cloning/adding remotes,
// reaching the network by any of the common tools/techniques with no legitimate
// use in a build/lint/test workflow, or deleting anything at an absolute path or
// under the user's home directory). See the file-level comment above for this
// mechanism's real limits — it is not a sandbox. It deliberately does NOT block
// bare interpreter invocation (python/node/perl/ruby) since the system prompt
// tells the model it may run local linters/type-checkers/test suites, which
// commonly shell out through exactly those interpreters — blocking them outright
// would break the feature's stated legitimate use far more than it narrows this
// gap, since a script-mediated or interpreter-internal HTTP call is not something
// a command-string regex can reliably distinguish from a legitimate build step.
//
// KNOWN RESIDUAL RISK: this run's environment (buildAgentEnv(), passed as `env`
// below) includes ANTHROPIC_API_KEY (if a custom key is configured) and inherits
// CLAUDE_CODE_OAUTH_TOKEN from the parent process (if that's the active auth
// source) — both are visible to any Bash child process this agent spawns. A
// sufficiently malicious task (e.g. from prompt injection in external ticket/PR
// content the upstream enrichment step read) could exfiltrate either via a
// technique this denylist doesn't cover. Closing this fully requires either not
// handing this agent a live credential at all (the Agent SDK needs one to make
// its own API calls, so today there is no way to withhold it from Bash without
// also breaking the run) or a real OS-level network sandbox — tracked as a
// follow-up, not solved by this denylist.
const BASH_DENY_RE = /\b(git\s+(push|fetch|pull|clone|remote|submodule|ls-remote)|sudo|curl|wget|\bnc\b|\bssh\b|\bscp\b|\brsync\b|\bftp\b|\btelnet\b|\bsocat\b|\bdig\b|\bnslookup\b|getent\s+hosts|\/dev\/(tcp|udp)\/|rm\s+-rf\s+(\/|~))/i

function isDisallowedBashCommand(cmd: string): boolean {
  return BASH_DENY_RE.test(cmd)
}

/** Fails closed: a missing/empty file_path is treated as outside the worktree,
 *  not allowed through by default. */
function isWithinWorktree(filePath: string | undefined, worktreePath: string): boolean {
  if (!filePath) return false
  const root = path.resolve(worktreePath)
  const resolved = path.resolve(worktreePath, filePath)
  return resolved === root || resolved.startsWith(root + path.sep)
}

export interface AuthoringResult {
  text: string
  ok: boolean
  error?: string
}

/**
 * Runs Claude with real file/shell tools (Bash/Edit/Read/Write/Grep/Glob) against
 * an isolated worktree to author a code change. Does not commit or push — the
 * caller (authoring.ts) reviews the diff and commits/pushes only once the user
 * taps "Ship it" (see worktree.ts captureDiff/commitAndPush).
 */
export async function runAuthoringAgent(
  worktreePath: string,
  taskPrompt: string,
  onProgress?: (status: string) => void,
): Promise<AuthoringResult> {
  const model = selectModel('authoring', taskPrompt.length)
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, AUTHORING_TIMEOUT_MS)

  const systemPrompt = 'You are mypa\'s code-authoring agent, working in an isolated git worktree on a fresh ' +
    'branch created for this task only. Make the minimal, correct change to address the task below, following ' +
    'the existing code\'s style and conventions. You may read files, search the codebase, and run local commands ' +
    '(e.g. a linter, type-checker, or test suite) to verify your change, but you have no network access and must ' +
    'never push, fetch, add a remote, or switch branches. When the change is complete and verified as well as you ' +
    'can, stop — do not commit; the user reviews the diff and mypa commits on their behalf afterward.'

  let text = ''
  let resultMsg: SDKResultMessage | null = null

  try {
    for await (const msg of query({
      prompt: taskPrompt,
      options: {
        systemPrompt,
        model,
        cwd: worktreePath,
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob'],
        maxTurns: 40,
        permissionMode: 'default',
        abortController: ac,
        env: buildAgentEnv(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        canUseTool: async (toolName: string, toolInput: unknown) => {
          const input = (toolInput as Record<string, unknown>) ?? {}
          if (toolName === 'Bash') {
            const cmd = String(input.command ?? '')
            if (isDisallowedBashCommand(cmd)) {
              return {
                behavior: 'deny',
                message: 'Command blocked in the authoring sandbox — no network access, and no git push/clone/remote/submodule operations are allowed.',
              }
            }
            return { behavior: 'allow', updatedInput: input }
          }
          if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
            const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
            if (!isWithinWorktree(filePath, worktreePath)) {
              return { behavior: 'deny', message: 'File path is outside the authoring worktree.' }
            }
            return { behavior: 'allow', updatedInput: input }
          }
          if (toolName === 'Grep' || toolName === 'Glob') {
            // Both tools default to `cwd` (the worktree) when path is omitted — only
            // deny when an explicit path was given and it resolves outside the worktree.
            // Without this, Grep in particular is a de facto arbitrary-file-read: it can
            // return matching file content from anywhere the OS user can reach.
            const searchPath = typeof input.path === 'string' ? input.path : undefined
            if (searchPath && !isWithinWorktree(searchPath, worktreePath)) {
              return { behavior: 'deny', message: 'Search path is outside the authoring worktree.' }
            }
            return { behavior: 'allow', updatedInput: input }
          }
          return { behavior: 'deny', message: 'Tool not available in the authoring sandbox' }
        },
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of (msg.message?.content ?? []) as any[]) {  // eslint-disable-line @typescript-eslint/no-explicit-any
          if (block.type === 'text') text += block.text
          if (block.type === 'tool_use' && onProgress) onProgress(`Using ${block.name ?? 'a tool'}…`)
        }
      }
      if (msg.type === 'result') resultMsg = msg
    }
  } catch (err) {
    clearTimeout(timer)
    if (timedOut) return { text, ok: false, error: 'Authoring run timed out' }
    return { text, ok: false, error: (err as Error).message }
  }

  clearTimeout(timer)

  if (!resultMsg) {
    return { text, ok: false, error: 'Authoring agent completed without a result message' }
  }
  recordSdkUsage('authoring', model, resultMsg)
  if (resultMsg.is_error) {
    const errText = typeof (resultMsg as any).result === 'string' ? (resultMsg as any).result : 'Authoring agent returned an error'
    return { text, ok: false, error: errText }
  }
  return { text, ok: true }
}
