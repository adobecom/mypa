import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { recordUsage } from './usage'
import { selectModel, escalate } from './model-router'
import type { UsageSource } from '@shared/types'

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
