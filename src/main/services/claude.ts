import { execFile, execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import cron from 'node-cron'
import { readConfig } from './config'
import type { PlanDraft, PlanItemTiming, ChatMessage, McpServerStatus, RoutineAction, RoutineSetupDraft } from '@shared/types'

const execFileAsync = promisify(execFile)

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

function modelArgs(): string[] {
  const model = readConfig().claude.model
  return model ? ['--model', model] : []
}

async function runClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
  const { stdout } = await execFileAsync(
    getClaude(),
    ['-p', fullPrompt, '--output-format', 'text', '--verbose', ...modelArgs()],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, input: '' }
  )
  return stdout.trim()
}

function parseStreamEvent(line: string, full: string, onChunk: (chunk: string) => void): string {
  if (!line.trim()) return full
  try {
    const event = JSON.parse(line)
    if (event.type === 'assistant') {
      const textBlocks = (event.message?.content ?? []).filter(
        (b: any) => b.type === 'text' && b.text
      )
      if (textBlocks.length > 0 && full) {
        onChunk('\x00SPLIT\x00')
      }
      for (const block of textBlocks) {
        full += block.text
        onChunk(block.text)
      }
    } else if (event.type === 'result' && !event.is_error && typeof event.result === 'string' && !full) {
      // Fallback: use the result event's text if no chunks were captured from assistant events
      full = event.result
      onChunk(event.result)
    }
  } catch {
    // ignore parse errors on partial lines
  }
  return full
}

async function runClaudeStream(
  systemPrompt: string,
  messages: { role: string; content: string }[],
  onChunk: (chunk: string) => void,
  streamId?: string
): Promise<string> {
  const history = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')
  const fullPrompt = `${systemPrompt}\n\n${history}`

  return new Promise((resolve, reject) => {
    const proc = spawn(getClaude(), [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      ...modelArgs()
    ])
    proc.stdin?.end()
    let full = ''
    let buf = ''
    let stderr = ''

    const entry = { proc, killed: false }
    if (streamId) activeStreams.set(streamId, entry)

    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.stdout.on('data', (data: Buffer) => {
      buf += data.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        full = parseStreamEvent(line, full, onChunk)
      }
    })

    proc.on('close', (code) => {
      if (buf.trim()) {
        full = parseStreamEvent(buf, full, onChunk)
      }
      if (streamId) activeStreams.delete(streamId)
      if (entry.killed || (code !== 0 && !full)) {
        reject(new Error(entry.killed ? 'Cancelled' : (stderr.trim() || `Claude process exited with code ${code}`)))
        return
      }
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
    `You are ${persona} helping organize work.
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
If no time hint → "anytime".`
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
  const persona = readConfig().persona?.trim() || 'a personal assistant'
  const text = await runClaude(
    `You are ${persona} digesting data feeds.
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
}`
  )

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { summary: 'Routine completed', items: [], proposed_actions: [] }
  }

  const parsed = JSON.parse(jsonMatch[0])
  return {
    summary: parsed.summary ?? 'Routine completed',
    items: parsed.items ?? [],
    proposed_actions: parsed.proposed_actions ?? []
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
          .map(
            (t) =>
              `  - name: ${t.name}\n    description: ${t.description}\n    inputSchema: ${JSON.stringify(t.inputSchema)}`
          )
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
- Only server/tool names verbatim from above. params must be a JSON object, never null or an array.`
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
  streamId?: string
): Promise<void> {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage }
  ]

  const persona = readConfig().persona?.trim() || 'a personal assistant'
  const systemPrompt = rawContext
    ? `You are mypa, ${persona}. Be concise and action-oriented.\n\nOriginal data collected by this routine:\n${rawContext}`
    : `You are mypa, ${persona}. Be concise and action-oriented.`

  const full = await runClaudeStream(systemPrompt, messages, onChunk, streamId)

  onDone(full)
}
