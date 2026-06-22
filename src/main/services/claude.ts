import { execSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import cron from 'node-cron'
import { readConfig, buildOwnerClause } from './config'
import { runAgent, runAgentWithMcp, streamAgentChat, cancelAgentChat } from './agent'
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

/**
 * One-shot Claude call — delegates to runAgent() (Agent SDK).
 * Kept for backward compatibility with existing callers.
 */
export async function runClaude(
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource = 'other',
  timeoutMs: number = 120_000,
  expectJson: boolean = false
): Promise<string> {
  return runAgent(systemPrompt, userPrompt, source, timeoutMs, expectJson)
}

export function cancelStream(streamId: string): boolean {
  return cancelAgentChat(streamId)
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

/** Delegates to runAgentWithMcp in agent.ts — kept for call-site compat. */
export async function runClaudeWithMcp(
  systemPrompt: string,
  userPrompt: string,
  source: UsageSource = 'suggest'
): Promise<string> {
  return runAgentWithMcp(systemPrompt, userPrompt, source)
}

// ─── Streaming chat ───────────────────────────────────────────────────────────

export async function streamChat(
  history: ChatMessage[],
  userMessage: string,
  onChunk: (chunk: string) => void,
  onDone: (fullText: string) => void,
  rawContext?: string,
  streamId?: string,
  source: UsageSource = 'chat',
  enableMcp?: boolean
): Promise<void> {
  return streamAgentChat(history, userMessage, onChunk, onDone, rawContext, streamId, source, enableMcp ?? false)
}
