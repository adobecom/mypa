import { execSync, spawn } from 'child_process'
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import cron from 'node-cron'
import { readConfig, buildOwnerClause } from './config'
import { recordUsage } from './usage'
import { getServerStatus } from './mcp'
import { selectModel, escalate } from './model-router'
import type { PlanDraft, PlanItemTiming, ChatMessage, McpServerStatus, RoutineAction, RoutineSetupDraft, UsageSource } from '@shared/types'


/** All ~/.nvm/versions/node/<ver>/bin dirs, newest version first. */
function nvmClaudePaths(home: string): string[] {
  const versionsDir = join(home, '.nvm', 'versions', 'node')
  try {
    return readdirSync(versionsDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(versionsDir, v, 'bin', 'claude'))
  } catch {
    return []
  }
}

// undefined = not yet probed; null = probed, not found; string = probed, found
let _npmGlobalBin: string | null | undefined = undefined

/** Best-effort: resolve `npm prefix -g`/bin via a subprocess. Cached for process lifetime. */
function npmGlobalBin(): string | null {
  if (_npmGlobalBin !== undefined) return _npmGlobalBin
  try {
    const prefix = execSync('npm prefix -g', { shell: '/bin/sh', encoding: 'utf8', timeout: 3000 }).trim()
    _npmGlobalBin = prefix ? join(prefix, 'bin') : null
  } catch {
    _npmGlobalBin = null
  }
  return _npmGlobalBin
}

/**
 * Resolve the claude CLI binary without throwing.
 * Order:
 *   1. PATH lookup via `which` (inherits the PATH that fixPath() already patched).
 *   2. Static list of well-known absolute install locations, including every
 *      nvm node-version bin dir (enumerated from disk, newest version first).
 * Returns an absolute path, or null if not found.
 */
export function detectClaudeBin(): string | null {
  // 1. PATH lookup
  try {
    const out = process.platform === 'win32'
      ? execSync('where claude', { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
      : execSync('which claude', { shell: '/bin/sh', encoding: 'utf8' }).trim()
    if (out && existsSync(out)) return out
  } catch {
    // fall through to static candidates
  }

  // 2. Known absolute install locations
  const home = process.env.HOME || ''
  const candidates: string[] = []
  if (home) {
    candidates.push(join(home, '.claude', 'local', 'claude'))   // official installer
    candidates.push(join(home, '.npm-global', 'bin', 'claude')) // npm prefix -g default
    candidates.push(join(home, '.local', 'bin', 'claude'))
    candidates.push(join(home, '.bun', 'bin', 'claude'))
    candidates.push(...nvmClaudePaths(home))                    // nvm: all node versions
  }
  candidates.push('/opt/homebrew/bin/claude')
  candidates.push('/usr/local/bin/claude')
  // best-effort: custom npm global prefix
  const npmBin = npmGlobalBin()
  if (npmBin) candidates.push(join(npmBin, 'claude'))

  for (const p of candidates) {
    try { if (existsSync(p)) return p } catch { /* unreadable, skip */ }
  }
  return null
}

// Cache only on success — a null result is not cached, so installing claude
// after launch is picked up on the next spawn (no restart required).
let _claudeBin: string | null = null
function getClaude(): string {
  if (_claudeBin) return _claudeBin
  const found = detectClaudeBin()
  if (!found) throw new Error('claude CLI not found — is Claude Code installed?')
  _claudeBin = found
  return _claudeBin
}

const activeStreams = new Map<string, { proc: import('child_process').ChildProcess; killed: boolean }>()

function modelArgs(model: string): string[] {
  return model ? ['--model', model] : []
}

function claudeEnv(key?: string): NodeJS.ProcessEnv {
  const k = key ?? readConfig().claude.apiKey
  return k ? { ...process.env, ANTHROPIC_API_KEY: k } : process.env
}

/**
 * Single-attempt one-shot Claude call. Public callers go through runClaude(),
 * which wraps this with automatic model selection and escalation on failure.
 */
async function runClaudeOnce(
  model: string,
  fullPrompt: string,
  source: UsageSource,
  timeoutMs: number,
  expectJson: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      getClaude(),
      ['-p', fullPrompt, '--output-format', 'json', ...modelArgs(model)],
      { stdio: ['ignore', 'pipe', 'pipe'], env: claudeEnv() }
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Claude timed out')) }, timeoutMs)
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
        // When the caller expects a JSON payload and the response contains none,
        // treat it as a weak output and trigger escalation.
        if (expectJson && !parsed.result.includes('{') && !parsed.result.includes('[')) {
          reject(new Error('Claude returned non-JSON response when JSON was expected'))
          return
        }
        resolve(parsed.result)
      } catch {
        // If the outer envelope isn't JSON (unexpected CLI version/mode)
        if (expectJson) {
          reject(new Error('Claude output could not be parsed'))
        } else {
          resolve(stdout.trim())
        }
      }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * One-shot Claude call with automatic model selection and failure escalation.
 *
 * The model is chosen by selectModel() based on the task's source and prompt
 * length. If the call fails (error, is_error, bad JSON when expectJson=true),
 * the call is automatically retried once at the next-stronger model tier.
 * No further escalation is attempted once the top tier is reached.
 *
 * Pass expectJson=true for tasks that require a valid JSON response body —
 * a non-JSON result will trigger escalation rather than silently resolving.
 */
export async function runClaude(
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource = 'other',
  timeoutMs: number = 120_000,
  expectJson: boolean = false
): Promise<string> {
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
  let model = selectModel(source, fullPrompt.length)
  while (true) {
    try {
      return await runClaudeOnce(model, fullPrompt, source, timeoutMs, expectJson)
    } catch (err) {
      // Timeouts are a resource/latency constraint, not a capability gap — escalating to
      // a slower model with the same budget would just repeat the timeout. Fail fast.
      if ((err as Error).message === 'Claude timed out') throw err
      const next = escalate(model)
      if (!next) throw err
      console.log(`[claude] escalating ${model} → ${next} (${source}): ${(err as Error).message}`)
      model = next
    }
  }
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
  streamId: string | undefined,
  source: UsageSource,
  model: string
): Promise<string> {
  const history = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')
  const fullPrompt = `${systemPrompt}\n\n${history}`

  return new Promise((resolve, reject) => {
    const proc = spawn(getClaude(), [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      ...modelArgs(model)
    ], { env: claudeEnv() })
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
    'plan_draft',
    120_000,
    true
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
  body: string
}

export async function generateRoutineDigest(
  routineName: string,
  promptTemplate: string,
  rawOutput: string
): Promise<RoutineDigest> {
  let text: string
  try {
    const persona = readConfig().persona?.trim() || 'a personal assistant'
    text = await runClaude(
      `You are ${persona} digesting data feeds.${buildOwnerClause()}
Fully perform the analysis described in the Instructions below. Do not just acknowledge the task — carry it out completely.
Format your response as:
SUMMARY: <one-sentence headline of the most important finding, max 120 chars>

<full markdown digest that follows any grouping or sections requested in the Instructions>`,
      `Routine: ${routineName}

Instructions: ${promptTemplate}

Raw data:
${rawOutput}`,
      'routine_digest',
      240_000
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[claude] routine digest failed:', err)
    return {
      summary: 'Could not generate digest',
      body: `The digest could not be generated. Reason: ${message}. The collected data is available under "Raw output".`
    }
  }

  // Parse the SUMMARY: prefix line and the markdown body below it.
  // This format is robust — no JSON fragility, no hard cap on content length.
  const lines = text.trim().split('\n')
  const summaryLineIdx = lines.findIndex((l) => l.trimStart().toUpperCase().startsWith('SUMMARY:'))

  let summary: string
  let body: string

  if (summaryLineIdx !== -1) {
    summary = lines[summaryLineIdx].replace(/^.*SUMMARY:\s*/i, '').trim()
    // Body = everything after the SUMMARY line, skipping any blank separator
    const bodyLines = lines.slice(summaryLineIdx + 1)
    const firstNonEmpty = bodyLines.findIndex((l) => l.trim().length > 0)
    body = (firstNonEmpty === -1 ? bodyLines : bodyLines.slice(firstNonEmpty)).join('\n').trim()
  } else {
    // No SUMMARY: line — use the first non-empty line as headline, full text as body
    const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? ''
    summary = firstNonEmpty.trim().slice(0, 120)
    body = text.trim()
  }

  if (!summary) summary = routineName
  if (!body) body = text.trim()

  return { summary, body }
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
    'routine_setup',
    120_000,
    true
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

// ─── MCP-enabled one-shot call (for Suggest re-proposal) ─────────────────────

/**
 * Prefixes for tool names considered safe for read-only access during Suggest.
 * Only tools whose names start with one of these are included in the allowlist.
 * Write-capable tools (create/post/send/delete/etc.) are excluded at this layer
 * in addition to the VERB_TO_TOOL allowlist that guards actual execution.
 */
const READ_ONLY_PREFIXES = [
  'get', 'list', 'search', 'read', 'fetch', 'view', 'find',
  'show', 'describe', 'query', 'lookup', 'check'
]

function isReadOnlyTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return READ_ONLY_PREFIXES.some((p) => lower.startsWith(p))
}

/**
 * Run a one-shot Claude call with the configured MCP servers wired in.
 * Only read-only tools are pre-approved; write tools are never included.
 *
 * The MCP config is written to a temp file, passed via --mcp-config, and
 * cleaned up after the call regardless of outcome.
 *
 * Returns the raw text output (may be a JSON envelope if the caller used
 * a structured response prompt).
 */
export async function runClaudeWithMcp(
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource = 'suggest'
): Promise<string> {
  const cfg = readConfig()
  const fullPromptLen = systemPrompt.length + userPrompt.length + 2
  const model = selectModel(source, fullPromptLen)

  // Build MCP config for the CLI: only servers that are configured
  const mcpConfig: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {}
  const allowedTools: string[] = []

  for (const srv of cfg.mcp_servers) {
    if (!srv.command) continue
    const safeName = srv.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    mcpConfig[safeName] = {
      command: srv.command,
      ...(srv.args && srv.args.length > 0 ? { args: srv.args } : {}),
      ...(srv.env && Object.keys(srv.env).length > 0 ? { env: srv.env } : {})
    }
    // Include only read-only tool names from this server's known tool list.
    // If the server isn't tracked by mcp.ts yet (e.g. not started), we don't know
    // its tools — skip allowedTools for that server (Claude CLI will refuse unknown tools).
    // Tool names that are NOT read-only are simply not listed, so the model can't call them.
  }

  // Get read-only tools from the currently connected servers
  for (const status of getServerStatus()) {
    if (!status.connected) continue
    const safeName = status.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    for (const tool of status.tools) {
      if (isReadOnlyTool(tool.name)) {
        allowedTools.push(`mcp__${safeName}__${tool.name}`)
      }
    }
  }

  if (Object.keys(mcpConfig).length === 0) {
    // No MCP servers configured — fall back to plain runClaude
    return runClaude(systemPrompt, userPrompt, source)
  }

  // Write temp MCP config file
  const mcpConfigPath = join(tmpdir(), `mypa-mcp-${Date.now()}.json`)
  try {
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2))
  } catch {
    return runClaude(systemPrompt, userPrompt, source)
  }

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
  const args = [
    '-p', fullPrompt,
    '--output-format', 'json',
    '--mcp-config', mcpConfigPath,
    ...modelArgs(model)
  ]
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','))
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(getClaude(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: claudeEnv(cfg.claude.apiKey)
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Claude (MCP) timed out')) }, 180_000)
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      clearTimeout(timer)
      try { unlinkSync(mcpConfigPath) } catch { /* best-effort cleanup */ }
      if (code !== 0) {
        reject(new Error(`Claude (MCP) failed: ${stderr || stdout}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim())
        recordUsage(source, model, parsed)
        if (parsed.is_error) {
          reject(new Error(String(parsed.result ?? parsed.error ?? 'Claude returned an error')))
          return
        }
        resolve(typeof parsed.result === 'string' ? parsed.result : stdout.trim())
      } catch {
        resolve(stdout.trim())
      }
    })
    proc.on('error', (err) => {
      try { unlinkSync(mcpConfigPath) } catch { /* best-effort cleanup */ }
      clearTimeout(timer)
      reject(err)
    })
  })
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

  // Approximate total chars for model selection (system prompt + all message content)
  const approxLen = systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0)
  let model = selectModel(source, approxLen)

  while (true) {
    try {
      const full = await runClaudeStream(systemPrompt, messages, onChunk, streamId, source, model)
      onDone(full)
      return
    } catch (err) {
      // User-cancelled streams must not be retried — the UI has already stopped
      if ((err as Error).message === 'Cancelled') throw err
      const next = escalate(model)
      if (!next) throw err
      console.log(`[claude] stream: escalating ${model} → ${next} (${source})`)
      model = next
    }
  }
}
