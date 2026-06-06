import { getServerStatus, callTool } from './mcp'
import { readConfig } from './config'
import { dbInsertSignal, computeFingerprint } from '../db/index'
import type { Signal, SignalInput, IntentSurface } from '@shared/types'

// ─── Adapter seam ─────────────────────────────────────────────────────────────
// A webhook receiver would implement the same normalize() half without touching
// the poll() side, then call dbInsertSignal directly.

export interface RawObservation {
  external_id: string
  kind: string
  title: string
  body: string
  actor: string
  url: string
  occurred_at: string | null
  change_fields: Record<string, unknown>
  raw: Record<string, unknown>
}

export interface SurfaceAdapter {
  surface: IntentSurface
  serverName: string
  isAvailable(): boolean
  poll(): Promise<RawObservation[]>
  normalize(raw: RawObservation): SignalInput
}

// ─── GitHub adapter ──────────────────────────────────────────────────────────

function makeGithubAdapter(): SurfaceAdapter {
  const surface: IntentSurface = 'github'
  const serverName = 'github'

  function isAvailable(): boolean {
    return getServerStatus().some((s) => s.name === serverName && s.connected)
  }

  async function poll(): Promise<RawObservation[]> {
    const obs: RawObservation[] = []
    const results: Array<{ tool: string; result: unknown }> = []

    // Pull requests assigned to / involving user
    try {
      const prs = await callTool(serverName, 'search_issues', {
        q: 'is:pr involves:@me is:open',
        per_page: 30
      })
      const parsed = safeParseJson<{ items?: unknown[] }>(prs, {})
      for (const item of parsed.items ?? []) {
        results.push({ tool: 'pr', result: item })
      }
    } catch (e) {
      console.warn('[ingestion:github] pr poll failed:', e)
    }

    // Issues assigned to or mentioning user
    try {
      const issues = await callTool(serverName, 'search_issues', {
        q: 'is:issue involves:@me is:open',
        per_page: 20
      })
      const parsed = safeParseJson<{ items?: unknown[] }>(issues, {})
      for (const item of parsed.items ?? []) {
        results.push({ tool: 'issue', result: item })
      }
    } catch (e) {
      console.warn('[ingestion:github] issue poll failed:', e)
    }

    for (const { tool, result } of results) {
      const r = result as Record<string, unknown>
      const id = String(r.number ?? r.id ?? '')
      if (!id) continue
      const kind = tool === 'pr' ? 'pull_request' : 'issue'
      obs.push({
        external_id: `${kind}:${id}`,
        kind,
        title: String(r.title ?? ''),
        body: String(r.body ?? '').slice(0, 500),
        actor: String((r.user as any)?.login ?? ''),
        url: String(r.html_url ?? r.url ?? ''),
        occurred_at: String(r.updated_at ?? r.created_at ?? ''),
        change_fields: {
          state: r.state,
          updated_at: r.updated_at,
          comments: r.comments,
          assignees: (r.assignees as any[])?.map((a: any) => a.login)
        },
        raw: r
      })
    }
    return obs
  }

  function normalize(raw: RawObservation): SignalInput {
    return {
      surface,
      kind: raw.kind,
      external_id: raw.external_id,
      fingerprint: computeFingerprint(surface, raw.external_id, raw.change_fields),
      title: raw.title,
      body: raw.body.slice(0, 500),
      actor: raw.actor,
      url: raw.url,
      occurred_at: raw.occurred_at,
      // Store only the safe reference fields — not the full API response which may
      // contain private content, PII, or secrets pasted in PR bodies / messages.
      raw: scrubRaw(raw.raw, ['number', 'id', 'html_url', 'url', 'state', 'updated_at',
        'created_at', 'repository', 'user'])
    }
  }

  return { surface, serverName, isAvailable, poll, normalize }
}

// ─── Jira adapter ─────────────────────────────────────────────────────────────

function makeJiraAdapter(): SurfaceAdapter {
  const surface: IntentSurface = 'jira'
  const serverName = 'jira'

  function isAvailable(): boolean {
    return getServerStatus().some((s) => s.name === serverName && s.connected)
  }

  async function poll(): Promise<RawObservation[]> {
    const obs: RawObservation[] = []
    try {
      const result = await callTool(serverName, 'jira_search', {
        jql: 'assignee = currentUser() OR mention = currentUser() ORDER BY updated DESC',
        fields: 'summary,status,assignee,reporter,updated,created,comment',
        limit: 30
      })
      const parsed = safeParseJson<{ issues?: unknown[] }>(result, {})
      for (const issue of parsed.issues ?? []) {
        const i = issue as Record<string, unknown>
        const fields = (i.fields as Record<string, unknown>) ?? {}
        obs.push({
          external_id: String(i.key ?? i.id ?? ''),
          kind: 'issue',
          title: String(fields.summary ?? ''),
          body: '',
          actor: String((fields.assignee as any)?.displayName ?? (fields.reporter as any)?.displayName ?? ''),
          url: String(i.self ?? ''),
          occurred_at: String(fields.updated ?? fields.created ?? ''),
          change_fields: {
            status: (fields.status as any)?.name,
            updated: fields.updated,
            comment_count: (fields.comment as any)?.total
          },
          raw: i
        })
      }
    } catch (e) {
      console.warn('[ingestion:jira] poll failed:', e)
    }
    return obs
  }

  function normalize(raw: RawObservation): SignalInput {
    return {
      surface,
      kind: raw.kind,
      external_id: raw.external_id,
      fingerprint: computeFingerprint(surface, raw.external_id, raw.change_fields),
      title: raw.title,
      body: raw.body.slice(0, 500),
      actor: raw.actor,
      url: raw.url,
      occurred_at: raw.occurred_at,
      raw: scrubRaw(raw.raw, ['id', 'key', 'self', 'issuetype', 'status', 'updated', 'created'])
    }
  }

  return { surface, serverName, isAvailable, poll, normalize }
}

// ─── Slack adapter ────────────────────────────────────────────────────────────

function makeSlackAdapter(): SurfaceAdapter {
  const surface: IntentSurface = 'slack'
  const serverName = 'slack'

  function isAvailable(): boolean {
    return getServerStatus().some((s) => s.name === serverName && s.connected)
  }

  async function poll(): Promise<RawObservation[]> {
    const obs: RawObservation[] = []
    try {
      const result = await callTool(serverName, 'slack_search_public', {
        query: 'from:me OR to:me',
        count: 20
      })
      const parsed = safeParseJson<{ messages?: { matches?: unknown[] } }>(result, {})
      for (const msg of parsed.messages?.matches ?? []) {
        const m = msg as Record<string, unknown>
        const ts = String(m.ts ?? '')
        obs.push({
          external_id: `${m.channel}:${ts}`,
          kind: 'message',
          title: String(m.text ?? '').slice(0, 200),
          body: String(m.text ?? '').slice(0, 500),
          actor: String((m.username as string) ?? (m.user as string) ?? ''),
          url: String(m.permalink ?? ''),
          occurred_at: ts ? new Date(parseFloat(ts) * 1000).toISOString() : null,
          change_fields: { ts, channel: m.channel },
          raw: m
        })
      }
    } catch (e) {
      console.warn('[ingestion:slack] poll failed:', e)
    }
    return obs
  }

  function normalize(raw: RawObservation): SignalInput {
    return {
      surface,
      kind: raw.kind,
      external_id: raw.external_id,
      fingerprint: computeFingerprint(surface, raw.external_id, raw.change_fields),
      title: raw.title,
      // Slack messages are stored as title only — body is dropped to avoid capturing
      // message content (which may include sensitive info) at rest in SQLite.
      body: '',
      actor: raw.actor,
      url: raw.url,
      occurred_at: raw.occurred_at,
      raw: scrubRaw(raw.raw, ['ts', 'channel', 'permalink', 'username', 'user'])
    }
  }

  return { surface, serverName, isAvailable, poll, normalize }
}

// ─── Polling scheduler ────────────────────────────────────────────────────────

export const adapters: SurfaceAdapter[] = [
  makeGithubAdapter(),
  makeJiraAdapter(),
  makeSlackAdapter()
]

// Stagger offsets so surfaces don't all call MCP in the same tick (ms)
const STAGGER_OFFSETS: Record<IntentSurface, number> = {
  github: 0,
  jira: 20_000,
  slack: 40_000
}

const intervalIds = new Map<IntentSurface, ReturnType<typeof setInterval>>()
let newSignalCallback: ((signals: Signal[]) => void) | null = null

export function startIngestion(onNewSignals: (signals: Signal[]) => void): void {
  if (intervalIds.size > 0) return // already running
  newSignalCallback = onNewSignals
  const cfg = readConfig()
  const baseMs = cfg.ambient?.pollIntervalMs ?? 5 * 60 * 1000

  for (const adapter of adapters) {
    const jitter = Math.floor(Math.random() * 90_000) - 45_000 // ±45 s
    const interval = baseMs + jitter
    const stagger = STAGGER_OFFSETS[adapter.surface]

    // Delay the first poll by the stagger so MCP connections can settle
    const initial = setTimeout(() => {
      runAdapterPoll(adapter).catch(console.error)
      const id = setInterval(() => {
        runAdapterPoll(adapter).catch(console.error)
      }, interval)
      intervalIds.set(adapter.surface, id)
    }, stagger + 3_000) // +3 s minimum before first poll

    // Keep a reference so we can clear it on stop
    intervalIds.set(adapter.surface, initial as unknown as ReturnType<typeof setInterval>)
  }
}

export function stopIngestion(): void {
  for (const id of intervalIds.values()) clearInterval(id)
  intervalIds.clear()
  newSignalCallback = null
}

export async function pollOnce(): Promise<Signal[]> {
  const all: Signal[] = []
  for (const adapter of adapters) {
    if (!adapter.isAvailable()) continue
    const signals = await runAdapterPoll(adapter)
    all.push(...signals)
  }
  return all
}

async function runAdapterPoll(adapter: SurfaceAdapter): Promise<Signal[]> {
  if (!adapter.isAvailable()) return []
  const newSignals: Signal[] = []
  try {
    const observations = await adapter.poll()
    for (const obs of observations) {
      const input = adapter.normalize(obs)
      const { inserted, id } = dbInsertSignal(input)
      if (inserted && id) {
        newSignals.push({
          id,
          ...input,
          observed_at: new Date().toISOString(),
          processed: false
        })
      }
    }
  } catch (e) {
    console.error(`[ingestion:${adapter.surface}] poll error:`, e)
  }
  if (newSignals.length > 0 && newSignalCallback) {
    newSignalCallback(newSignals)
  }
  return newSignals
}

// Keep only the specified allow-listed keys from a raw API response.
// This prevents full API payloads (which may contain private body text, PII, or tokens)
// from being stored at rest in SQLite or sent to the LLM.
function scrubRaw(raw: Record<string, unknown>, allowKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of allowKeys) {
    if (key in raw) out[key] = raw[key]
  }
  return out
}

function safeParseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text)
  } catch {
    // MCP tools return text; try to extract JSON object/array
    const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (match) {
      try { return JSON.parse(match[1]) } catch { /* */ }
    }
    return fallback
  }
}
