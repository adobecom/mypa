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
import type { UsageSource, ChatMessage, PendingToolApproval, PendingQuestion } from '@shared/types'

const STREAM_IDLE_TIMEOUT_MS = 120_000

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

/** Build the in-process MCP server that exposes ask_user for this stream. */
function buildAskUserServer(streamId: string) {
  const askUserTool = tool(
    'ask_user',
    'Ask the user to select from a list of options. Use this whenever you need the user to make a choice — never list options as bullet points and never fabricate a selection.',
    {
      prompt: z.string().describe('The question to present to the user'),
      options: z.array(z.string()).min(2).max(6).describe('The available choices (2–6 items)'),
      multiSelect: z.boolean().optional().describe('Allow the user to select multiple options'),
    },
    async (args) => {
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
      const answer = await answerPromise
      pendingQuestions.delete(questionId)
      pendingQuestionCancels.delete(streamId)
      const text = Array.isArray(answer) ? answer.join(', ') : answer
      return { content: [{ type: 'text' as const, text }] }
    },
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

function isReadOnlyTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  if (!READ_ONLY_PREFIXES.some((p) => lower === p || lower.startsWith(p + '_'))) return false
  const words = lower.split('_')
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
  expectJson: boolean
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
): Promise<void> {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  const cfg = readConfig()
  const persona = cfg.persona?.trim() || 'a personal assistant'
  const ownerClause = buildOwnerClause()
  const askUserGuidance = 'When you need the user to choose between options, always call the ask_user tool — never list options as bullet points and never select an answer yourself.'
  const systemPrompt = rawContext
    ? `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented. ${askUserGuidance}\n\nOriginal data collected:\n${rawContext}`
    : `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented. ${askUserGuidance}`

  // Build SDK mcpServers map from config when MCP is requested
  const sdkMcpServers: Record<string, { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }> = {}
  if (enableMcp) {
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
  }

  const approxLen = systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0)
  let model = selectModel(source, approxLen)

  while (true) {
    try {
      const full = await streamAgentChatOnce(
        model, systemPrompt, messages, onChunk, streamId, source,
        Object.keys(sdkMcpServers).length > 0 ? sdkMcpServers : undefined,
      )
      onDone(full)
      return
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'Cancelled' || msg === 'Stream timed out') throw err
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
  mcpServers?: Record<string, { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }>,
): Promise<string> {
  // Format conversation as a flat prompt — mirrors the CLI's -p approach.
  const prompt = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')

  const ac = new AbortController()
  let timedOut = false
  let idleTimer = setTimeout(() => { timedOut = true; ac.abort() }, STREAM_IDLE_TIMEOUT_MS)

  const resetIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { timedOut = true; ac.abort() }, STREAM_IDLE_TIMEOUT_MS)
  }

  // Always attach the ask_user in-process server so the model can ask questions
  const allMcpServers: Record<string, any> = { ...(mcpServers ?? {}) }  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (streamId) allMcpServers['mypa_builtin'] = buildAskUserServer(streamId)
  const hasMcp = Object.keys(allMcpServers).length > 0

  const q = query({
    prompt,
    options: {
      systemPrompt,
      model,
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

        // Always allow our own built-in tools (ask_user etc.)
        if (serverName === 'mypa_builtin') return { behavior: 'allow' }

        if (isReadOnlyTool(baseName)) return { behavior: 'allow' }

        if (!mcpServers || !streamId) {
          return { behavior: 'deny', message: 'Write tools require an active MCP-enabled chat session' }
        }

        // Gate write tools via user approval
        const approvalId = crypto.randomUUID()
        const approval = buildPendingToolApproval(
          approvalId, toolName, (toolInput as Record<string, unknown>) ?? {}, streamId,
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
        const { allow, editedInput } = await resultPromise
        pendingToolApprovals.delete(approvalId)
        pendingApprovalCancels.delete(streamId)
        if (!allow) return { behavior: 'deny', message: 'Dismissed by user' }
        return editedInput ? { behavior: 'allow', updatedInput: editedInput } : { behavior: 'allow' }
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
      if (msg.type === 'assistant') {
        const textBlocks = (msg.message?.content ?? []).filter(
          (b: any) => b.type === 'text' && typeof b.text === 'string' && b.text,
        )
        if (textBlocks.length > 0 && hasText) {
          onChunk('\x00SPLIT\x00')
        }
        for (const block of textBlocks as any[]) {
          full += block.text
          hasText = true
          onChunk(block.text)
        }
      }
      if (msg.type === 'result') resultMsg = msg
    }
  } catch (err) {
    clearTimeout(idleTimer)
    if (streamId) activeAgentChats.delete(streamId)
    // Drain any pending approval/question promises so they don't leak on unexpected errors.
    if (streamId) {
      const cancelApproval = pendingApprovalCancels.get(streamId)
      if (cancelApproval) { cancelApproval(); pendingApprovalCancels.delete(streamId) }
      const cancelQuestion = pendingQuestionCancels.get(streamId)
      if (cancelQuestion) { cancelQuestion(); pendingQuestionCancels.delete(streamId) }
    }
    if (timedOut) throw new Error('Stream timed out')
    if (entry.interrupted) throw new Error('Cancelled')
    throw err
  }

  clearTimeout(idleTimer)
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
        maxTurns: 10,
        permissionMode: 'default',
        mcpServers,
        env: buildAgentEnv(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        canUseTool: async (toolName: string) => {
          const parts = toolName.split('__')
          const baseName = parts.length >= 3 ? parts.slice(2).join('__') : toolName
          if (isReadOnlyTool(baseName)) return { behavior: 'allow' }
          return { behavior: 'deny', message: 'write tools not available in one-shot MCP mode' }
        },
        abortController: ac,
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if ((block as any).type === 'text') text += (block as any).text
        }
      }
      if (msg.type === 'result') resultMsg = msg
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
