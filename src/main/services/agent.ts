import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { recordUsage } from './usage'
import { selectModel, escalate } from './model-router'
import { readConfig, buildOwnerClause } from './config'
import type { UsageSource, ChatMessage } from '@shared/types'

const STREAM_IDLE_TIMEOUT_MS = 120_000

interface ActiveAgentChat {
  q: Query
  interrupted: boolean
}

const activeAgentChats = new Map<string, ActiveAgentChat>()

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
        maxTurns: 1,
        permissionMode: 'default',
        // Deny all tools — this is a pure text-generation call, not an agentic session.
        // Keeps one-shot calls deterministic and prevents Claude Code built-ins from running.
        canUseTool: async () => ({ behavior: 'deny', message: 'one-shot mode — no tools' }),
        abortController: ac,
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
  if (timedOut) throw new Error('Agent timed out')

  if (!resultMsg) {
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
  const entry = activeAgentChats.get(streamId)
  if (!entry) return false
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
): Promise<void> {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  const persona = readConfig().persona?.trim() || 'a personal assistant'
  const ownerClause = buildOwnerClause()
  const systemPrompt = rawContext
    ? `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented.\n\nOriginal data collected:\n${rawContext}`
    : `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented.`

  const approxLen = systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0)
  let model = selectModel(source, approxLen)

  while (true) {
    try {
      const full = await streamAgentChatOnce(model, systemPrompt, messages, onChunk, streamId, source)
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
): Promise<string> {
  // Format conversation as a flat prompt — mirrors the CLI's -p approach so
  // callers don't need to change; multi-turn MCP sessions come in Phase 3.
  const prompt = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')

  const ac = new AbortController()
  let timedOut = false
  let idleTimer = setTimeout(() => { timedOut = true; ac.abort() }, STREAM_IDLE_TIMEOUT_MS)

  const resetIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { timedOut = true; ac.abort() }, STREAM_IDLE_TIMEOUT_MS)
  }

  const q = query({
    prompt,
    options: {
      systemPrompt,
      model,
      maxTurns: 1,
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'tools available from Phase 3' }),
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
    if (timedOut) throw new Error('Stream timed out')
    if (entry.interrupted) throw new Error('Cancelled')
    throw err
  }

  clearTimeout(idleTimer)
  if (streamId) activeAgentChats.delete(streamId)
  if (timedOut) throw new Error('Stream timed out')

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
      onChunk(r)
    }
  }

  return full
}
