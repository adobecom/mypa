import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import cron from 'node-cron'
import { readConfig, buildOwnerClause } from './config'
import { recordUsage } from './usage'
import type { PlanDraft, PlanItemTiming, ChatMessage, McpServerStatus, RoutineAction, RoutineSetupDraft, UsageSource } from '@shared/types'


function findClaude(): string {
  try {
    return execSync('which claude', { shell: true }).toString().trim()
  } catch {
    for (const p of ['/usr/local/bin/claude', `${process.env.HOME}/.local/bin/claude`]) {
      if (existsSync(p)) return p
    }
    throw new Error('claude CLI not found — is Claude Code installed?')
  }
}

let _claudeBin: string | null = null
function getClaude(): string {
  if (!_claudeBin) _claudeBin = findClaude()
  return _claudeBin
}

const activeStreams = new Map<string, { proc: import('child_process').ChildProcess; killed: boolean }>()

function modelArgs(model?: string): string[] {
  const m = model ?? readConfig().claude.model
  return m ? ['--model', m] : []
}

function claudeEnv(key?: string): NodeJS.ProcessEnv {
  const k = key ?? readConfig().claude.apiKey
  return k ? { ...process.env, ANTHROPIC_API_KEY: k } : process.env
}

export async function runClaude(
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource = 'other'
): Promise<string> {
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
  const cfg = readConfig().claude
  const model = cfg.model ?? ''
  return new Promise((resolve, reject) => {
    const proc = spawn(
      getClaude(),
      ['-p', fullPrompt, '--output-format', 'json', ...modelArgs(cfg.model)],
      { stdio: ['ignore', 'pipe', 'pipe'], env: claudeEnv(cfg.apiKey) }
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Claude timed out')) }, 120_000)
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`Command failed: ${stderr || stdout}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim())
        // Record usage regardless of error — tokens are consumed either way
        recordUsage(source, model, parsed)
        if (parsed.is_error) {
          reject(new Error(String(parsed.result ?? parsed.error ?? 'Claude returned an error')))
          return
        }
        // parsed.result should always be a string in text-output mode; guard defensively
        if (typeof parsed.result !== 'string') {
          reject(new Error('Claude returned unexpected result format'))
          return
        }
        resolve(parsed.result)
      } catch {
        // If the output isn't JSON (unexpected CLI version/mode), fall back to raw stdout
        resolve(stdout.trim())
      }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function parseStreamEvent(
  line: string,
  full: string,
  onChunk: (chunk: string) => void,
  onResult?: (event: any) => void
): string {
  if (!line.trim()) return full
  try {
    const event = JSON.parse(line)
    if (event.type === 'assistant') {
      // Only extract plain text blocks — skip tool_use and any other structured blocks
      const textBlocks = (event.message?.content ?? []).filter(
        (b: any) => b.type === 'text' && typeof b.text === 'string' && b.text
      )
      if (textBlocks.length > 0 && full) {
        onChunk('\x00SPLIT\x00')
      }
      for (const block of textBlocks) {
        full += block.text
        onChunk(block.text)
      }
    } else if (event.type === 'result') {
      // Always forward the full result event to the onResult callback for usage capture
      onResult?.(event)
      if (!event.is_error && !full) {
        // Fallback: only use the result event when no assistant text was captured and
        // the result looks like a plain prose string (not a JSON blob or structured data).
        const resultText = typeof event.result === 'string' ? event.result.trim() : ''
        if (resultText && !resultText.startsWith('{') && !resultText.startsWith('[')) {
          full = resultText
          onChunk(resultText)
        }
      }
    }
    // Explicitly ignore: 'system', 'user' (tool_result), 'tool_use', and all other event types
  } catch {
    // ignore parse errors on partial lines
  }
  return full
}

async function runClaudeStream(
  systemPrompt: string,
  messages: { role: string; content: string }[],
  onChunk: (chunk: string) => void,
  streamId?: string,
  source: UsageSource = 'chat'
): Promise<string> {
  const history = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')
  const fullPrompt = `${systemPrompt}\n\n${history}`
  const cfg = readConfig().claude
  const model = cfg.model ?? ''

  return new Promise((resolve, reject) => {
    const proc = spawn(getClaude(), [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      ...modelArgs(cfg.model)
    ], { env: claudeEnv(cfg.apiKey) })
    proc.stdin?.end()
    let full = ''
    let buf = ''
    let stderr = ''
    let cliResult: any = null

    const entry = { proc, killed: false }
    if (streamId) activeStreams.set(streamId, entry)

    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.stdout.on('data', (data: Buffer) => {
      buf += data.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        full = parseStreamEvent(line, full, onChunk, (ev) => { cliResult = ev })
      }
    })

    proc.on('close', (code) => {
      if (buf.trim()) {
        full = parseStreamEvent(buf, full, onChunk, (ev) => { cliResult = ev })
      }
      if (streamId) activeStreams.delete(streamId)
      if (entry.killed || (code !== 0 && !full)) {
        reject(new Error(entry.killed ? 'Cancelled' : (stderr.trim() || `Claude process exited with code ${code}`)))
        return
      }
      // Record usage from the result event (contains usage + total_cost_usd)
      if (cliResult) recordUsage(source, model, cliResult)
      resolve(full)
    })
    proc.on('error', (err) => {
      if (streamId) activeStreams.delete(streamId)
      reject(err)
    })
  })
}

export function cancelStream(streamId: string): boolean {
  const entry = activeStreams.get(streamId)
  if (!entry) return false
  entry.killed = true
  entry.proc.kill('SIGTERM')
  activeStreams.delete(streamId)
  return true
}

// ─── Plan item draft ─────────────────────────────────────────────────────────

export async function generatePlanDraft(intent: string): Promise<PlanDraft> {
  const now = new Date()
  const hour = now.getHours()

  const persona = readConfig().persona?.trim() || 'a personal assistant'
  const text = await runClaude(
    `You are ${persona} helping organize work.${buildOwnerClause()}
The current time is ${now.toLocaleTimeString()} (hour: ${hour}).
Respond ONLY with valid JSON matching the schema provided. No markdown, no explanation.`,
    `Parse this intent into a structured plan item. Return JSON only.

Intent: "${intent}"

Schema:
{
  "title": "short action-oriented title (max 60 chars)",
  "detail": "brief context or steps if obvious from intent, otherwise empty string",
  "timing": one of: "now" | "morning" | "afternoon" | "evening" | "anytime",
  "actions": []
}

Timing guide: morning=before noon, afternoon=noon-5pm, evening=after 5pm.
If the intent says "before standup", "this morning", "now", "ASAP" → "now" or "morning".
If no time hint → "anytime".`,
    'plan_draft'
  )

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude returned invalid JSON')

  const parsed = JSON.parse(jsonMatch[0])
  return {
    title: parsed.title ?? intent,
    detail: parsed.detail ?? '',
    timing: (parsed.timing as PlanItemTiming) ?? 'anytime',
    actions: parsed.actions ?? [],
    original_intent: intent
  }
}

// ─── Routine digest ───────────────────────────────────────────────────────────

export interface RoutineDigest {
  summary: string
  items: string[]
  proposed_actions: string[]
}

export async function generateRoutineDigest(
  routineName: string,
  promptTemplate: string,
  rawOutput: string
): Promise<RoutineDigest> {
  const defaultDigest: RoutineDigest = {
    summary: `${routineName} completed`,
    items: [],
    proposed_actions: []
  }

  let text: string
  try {
    const persona = readConfig().persona?.trim() || 'a personal assistant'
    text = await runClaude(
      `You are ${persona} digesting data feeds.${buildOwnerClause()}
Respond ONLY with valid JSON matching the schema provided.`,
      `Routine: ${routineName}

Instructions: ${promptTemplate}

Raw data:
${rawOutput}

Return JSON:
{
  "summary": "one sentence headline (max 100 chars)",
  "items": ["item needing attention", ...],
  "proposed_actions": ["I can do X", "Want me to Y?", ...]
}`,
      'routine_digest'
    )
  } catch {
    return defaultDigest
  }

  // Strip markdown fences if Claude wrapped the JSON
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return defaultDigest

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : defaultDigest.summary,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      proposed_actions: Array.isArray(parsed.proposed_actions) ? parsed.proposed_actions : []
    }
  } catch {
    return defaultDigest
  }
}

// ─── Routine setup ───────────────────────────────────────────────────────────

export async function generateRoutineSetup(
  intent: string,
  servers: McpServerStatus[]
): Promise<RoutineSetupDraft> {
  const toolCatalog = servers
    .filter((s) => s.connected && s.tools.length > 0)
    .map(
      (s) =>
        `Server: ${s.name}\nTools:\n${s.tools
          .map((t) => {
            const props = Object.entries(t.inputSchema?.properties ?? {})
              .map(([k, v]: [string, any]) => `${k}(${v.type ?? 'any'})`)
              .join(', ')
            return `  - name: ${t.name}\n    description: ${t.description}\n    params: {${props}}`
          })
          .join('\n')}`
    )
    .join('\n\n')

  const text = await runClaude(
    `You are a configuration assistant for mypa, a developer productivity app.
Your only job is to produce a routine configuration JSON from the user's intent and the available MCP tools.
Respond ONLY with valid JSON. No markdown fences, no explanation, no preamble.`,
    `The user wants: "${intent}"

Available MCP servers and tools:
${toolCatalog || '(none connected)'}

Return JSON:
{
  "name": "Short routine name (max 50 chars, action-oriented)",
  "cron": "cron expression for when to run. Use comma-separated hours for multiple times, e.g. \\"0 9,17 * * 1-5\\". Default to \\"0 9 * * 1-5\\" if no time is mentioned.",
  "actions": [
    { "server": "<exact server name>", "tool": "<exact tool name>", "params": { ... } }
  ],
  "prompt": "2-4 sentence digest instructions specific to this routine's purpose."
}

Cron rules:
- Format: "0 <hour(s)> * * <dow>" (minute is always 0)
- Single time: "0 9 * * 1-5" = 9 AM weekdays
- Multiple times: "0 9,17 * * 1-5" = 9 AM and 5 PM weekdays
- All days: use "*" for dow; weekdays only: use "1-5"
- Hours are 0-23 (9=9AM, 17=5PM). "twice daily" or "9 and 5" → "0 9,17 * * *"
- Only server/tool names verbatim from above. params must be a JSON object, never null or an array.`,
    'routine_setup'
  )

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude returned invalid JSON for routine setup')

  const parsed = JSON.parse(jsonMatch[0])

  const validTools = new Set(
    servers.flatMap((s) => s.tools.map((t) => `${s.name}::${t.name}`))
  )

  const actions: RoutineAction[] = (parsed.actions ?? [])
    .filter(
      (a: any) =>
        typeof a.server === 'string' &&
        typeof a.tool === 'string' &&
        validTools.has(`${a.server}::${a.tool}`)
    )
    .map((a: any) => ({
      server: a.server,
      tool: a.tool,
      params:
        typeof a.params === 'object' && a.params !== null && !Array.isArray(a.params)
          ? a.params
          : {}
    }))

  const rawCron = typeof parsed.cron === 'string' ? parsed.cron : undefined
  const validatedCron = rawCron && cron.validate(rawCron) ? rawCron : undefined

  return {
    name:
      typeof parsed.name === 'string' ? parsed.name.slice(0, 50) : intent.slice(0, 50),
    actions,
    prompt:
      typeof parsed.prompt === 'string'
        ? parsed.prompt
        : 'Summarize the most important items that need my attention.\nBe concise. Highlight anything urgent or time-sensitive.\nPropose 2-3 specific follow-up actions I can take.',
    cron: validatedCron
  }
}

// ─── Streaming chat ───────────────────────────────────────────────────────────

export async function streamChat(
  history: ChatMessage[],
  userMessage: string,
  onChunk: (chunk: string) => void,
  onDone: (fullText: string) => void,
  rawContext?: string,
  streamId?: string,
  source: UsageSource = 'chat'
): Promise<void> {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage }
  ]

  const persona = readConfig().persona?.trim() || 'a personal assistant'
  const ownerClause = buildOwnerClause()
  const systemPrompt = rawContext
    ? `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented.\n\nOriginal data collected by this routine:\n${rawContext}`
    : `You are mypa, ${persona}.${ownerClause} Be concise and action-oriented.`

  const full = await runClaudeStream(systemPrompt, messages, onChunk, streamId, source)

  onDone(full)
}
