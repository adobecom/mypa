import { getServerStatus, callTool } from './mcp'
import { readConfig, getOwnerHandles } from './config'
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
  // "Needs me" fields set by adapters
  relation?: string | null
  directed?: boolean
  last_actor?: string | null
  due_at?: string | null
}

export interface SurfaceAdapter {
  surface: IntentSurface
  serverName: string
  isAvailable(): boolean
  /**
   * Fetch the latest batch of observations from the adapter.
   * `complete` must be true only when the poll returned the full result set without
   * truncation — i.e. no single query hit its page/count limit. This flag is used by
   * revalidatePendingIntents() to safely infer that a missing item has genuinely
   * disappeared from the user's active feed rather than been dropped by pagination.
   */
  poll(): Promise<{ observations: RawObservation[]; complete: boolean }>
  normalize(raw: RawObservation): SignalInput
}

// ─── Owner handle helpers ─────────────────────────────────────────────────────

/** Returns true if `handle` matches any of the configured owner handles (case-insensitive). */
function isOwnerHandle(handle: string): boolean {
  if (!handle) return false
  const lower = handle.toLowerCase()
  return getOwnerHandles().some((h) => lower === h.toLowerCase() || lower.includes(h.toLowerCase()))
}

// ─── GitHub adapter ──────────────────────────────────────────────────────────

// Max items to fetch the latest comment for per poll. Prioritise: review_requested > assigned > mentioned.
const MAX_GITHUB_COMMENT_FETCHES = 15

function makeGithubAdapter(): SurfaceAdapter {
  const surface: IntentSurface = 'github'
  const serverName = 'github'

  function isAvailable(): boolean {
    return getServerStatus().some((s) => s.name === serverName && s.connected)
  }

  /** Returns the login of the latest commenter on a GitHub issue/PR, or null on failure. */
  async function fetchLatestCommentActor(itemNumber: string): Promise<string | null> {
    // Confirm the tool is available before calling
    const server = getServerStatus().find((s) => s.name === serverName && s.connected)
    if (!server) return null
    const toolName = server.tools.find(
      (t) => t.name === 'get_issue_comments' || t.name === 'list_issue_comments'
    )?.name
    if (!toolName) return null
    try {
      const raw = await callTool(serverName, toolName, { issue_number: Number(itemNumber) })
      const parsed = safeParseJson<unknown[]>(raw, [])
      const arr = Array.isArray(parsed) ? parsed : []
      if (arr.length === 0) return null
      const last = arr[arr.length - 1] as Record<string, unknown>
      return String((last.user as any)?.login ?? '') || null
    } catch {
      return null
    }
  }

  async function poll(): Promise<{ observations: RawObservation[]; complete: boolean }> {
    // Role-tagged queries — more specific than `involves:@me` so we know WHY this item matters.
    // Priority order for de-dup: review_requested > assigned > mentioned > involved.
    const PER_PAGE = 50  // raised from 20 to reduce truncation (truncation disables freshness expiry)
    const QUERIES: Array<{ q: string; relation: string; kind: 'pr' | 'issue' | 'both' }> = [
      { q: 'is:open is:pr review-requested:@me',  relation: 'review_requested', kind: 'pr' },
      { q: 'is:open assigned:@me',                 relation: 'assigned',         kind: 'both' },
      { q: 'is:open mentions:@me',                 relation: 'mentioned',        kind: 'both' },
      { q: 'is:open involves:@me',                 relation: 'involved',         kind: 'both' },
    ]

    // Map from external_id → {result, relation} — keeps highest-priority relation on de-dup
    const byId = new Map<string, { r: Record<string, unknown>; relation: string; kind: string }>()
    let truncated = false

    for (const { q, relation, kind } of QUERIES) {
      const types = kind === 'pr' ? ['pr'] : kind === 'issue' ? ['issue'] : ['pr', 'issue']
      for (const itemType of types) {
        const searchQ = itemType === 'pr'
          ? q.includes('is:pr') ? q : `${q} is:pr`
          : q.includes('is:issue') ? q : `${q} is:issue`
        try {
          const res = await callTool(serverName, 'search_issues', { q: searchQ, per_page: PER_PAGE })
          const parsed = safeParseJson<{ items?: unknown[] }>(res, {})
          const items = parsed.items ?? []
          // If we got back a full page, results may have been truncated — mark incomplete
          if (items.length >= PER_PAGE) truncated = true
          for (const item of items) {
            const r = item as Record<string, unknown>
            const id = String(r.number ?? r.id ?? '')
            if (!id) continue
            const extKind = itemType === 'pr' ? 'pull_request' : 'issue'
            const extId = `${extKind}:${id}`
            if (!byId.has(extId)) {
              byId.set(extId, { r, relation, kind: extKind })
            }
            // else: already recorded with higher-priority relation — skip
          }
        } catch (e) {
          console.warn(`[ingestion:github] query "${searchQ}" failed:`, e)
          truncated = true  // treat query failure as potentially truncated
        }
      }
    }

    // Fetch latest comment actor for high-priority candidates (review_requested > assigned > mentioned)
    const highPriority = [...byId.entries()]
      .filter(([, v]) => v.relation !== 'involved')
      .slice(0, MAX_GITHUB_COMMENT_FETCHES)

    const commentActors = new Map<string, string | null>()
    for (const [extId, { r, relation }] of highPriority) {
      const itemNumber = String(r.number ?? '')
      if (!itemNumber) continue
      if (relation === 'review_requested') {
        // review_requested is always directed at me — skip comment fetch
        commentActors.set(extId, null)
      } else {
        commentActors.set(extId, await fetchLatestCommentActor(itemNumber))
      }
    }

    const obs: RawObservation[] = []
    for (const [extId, { r, relation, kind }] of byId) {
      const itemNumber = String(r.number ?? '')
      const lastActor = commentActors.get(extId) ?? null

      // directed: review requests are always directed; for others, last commenter must be non-owner
      const directed =
        relation === 'review_requested' ||
        (lastActor !== null && !isOwnerHandle(lastActor))

      obs.push({
        external_id: extId,
        kind,
        title: String(r.title ?? ''),
        body: String(r.body ?? '').slice(0, 500),
        actor: String((r.user as any)?.login ?? ''),
        url: String(r.html_url ?? r.url ?? ''),
        occurred_at: String(r.updated_at ?? r.created_at ?? ''),
        relation,
        directed,
        last_actor: lastActor,
        due_at: null, // GitHub milestones not surfaced in search results
        change_fields: {
          state: r.state,
          updated_at: r.updated_at,
          comments: r.comments,
          assignees: (r.assignees as any[])?.map((a: any) => a.login),
          last_actor: lastActor, // included in fingerprint — new comment registers as changed
        },
        raw: r
      })
    }
    return { observations: obs, complete: !truncated }
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
      relation: raw.relation ?? null,
      directed: raw.directed ?? false,
      last_actor: raw.last_actor ?? null,
      due_at: raw.due_at ?? null,
      // Metadata-only fields — no free-text body content stored beyond title/body already captured.
      raw: scrubRaw(raw.raw, [
        'number', 'id', 'html_url', 'url', 'state', 'draft',
        'updated_at', 'created_at', 'repository', 'user',
        'assignee', 'assignees', 'requested_reviewers', 'labels', 'milestone', 'pull_request'
      ])
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

  async function poll(): Promise<{ observations: RawObservation[]; complete: boolean }> {
    const obs: RawObservation[] = []
    const LIMIT = 30
    let truncated = false
    try {
      const result = await callTool(serverName, 'jira_search', {
        jql: 'assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser() ORDER BY updated DESC',
        // Added duedate, priority, issuelinks — enables relation/dependency edges
        fields: 'summary,status,assignee,reporter,updated,created,comment,duedate,priority,issuelinks',
        limit: LIMIT
      })
      const parsed = safeParseJson<{ issues?: unknown[] }>(result, {})
      if ((parsed.issues?.length ?? 0) >= LIMIT) truncated = true
      const ownerHandles = getOwnerHandles()

      for (const issue of parsed.issues ?? []) {
        const i = issue as Record<string, unknown>
        const fields = (i.fields as Record<string, unknown>) ?? {}

        // Determine relation: assignee == me → assigned, else → mentioned
        const assigneeDisplay = String((fields.assignee as any)?.displayName ?? '')
        const assigneeAccount = String((fields.assignee as any)?.accountId ?? '')
        const isAssigned = ownerHandles.length > 0 && ownerHandles.some((h) =>
          assigneeDisplay.toLowerCase().includes(h.toLowerCase()) ||
          assigneeAccount.toLowerCase().includes(h.toLowerCase())
        )
        const relation = isAssigned ? 'assigned' : 'mentioned'

        // Latest comment author → last_actor + directed
        const comments = (fields.comment as any)?.comments ?? []
        const lastComment = comments.length > 0 ? comments[comments.length - 1] : null
        const lastCommentAuthor = String(lastComment?.author?.displayName ?? '')
        const lastActor = lastCommentAuthor || null
        const directed = relation === 'assigned' ||
          (lastActor !== null && !isOwnerHandle(lastActor))

        // Body from latest comment — helps REQUEST_PATTERNS and context assembly
        const latestCommentBody = lastComment ? String(lastComment.body ?? '').slice(0, 500) : ''

        obs.push({
          external_id: String(i.key ?? i.id ?? ''),
          kind: 'issue',
          title: String(fields.summary ?? ''),
          body: latestCommentBody,
          actor: String(assigneeDisplay || (fields.reporter as any)?.displayName || ''),
          url: String(i.self ?? ''),
          occurred_at: String(fields.updated ?? fields.created ?? ''),
          relation,
          directed,
          last_actor: lastActor,
          due_at: fields.duedate ? String(fields.duedate) : null,
          change_fields: {
            status: (fields.status as any)?.name,
            updated: fields.updated,
            comment_count: (fields.comment as any)?.total,
            last_actor: lastActor, // fingerprint changes when new person comments
          },
          raw: i
        })
      }
    } catch (e) {
      console.warn('[ingestion:jira] poll failed:', e)
      truncated = true  // treat poll failure as potentially truncated
    }
    return { observations: obs, complete: !truncated }
  }

  function normalize(raw: RawObservation): SignalInput {
    // Build a curated fields sub-object so graph derivation (assignee, issuelinks, sprint) works
    // while avoiding storing full descriptions, custom fields, or arbitrary user content.
    const rawFields = (raw.raw.fields as Record<string, unknown>) ?? {}
    const curatedFields = {
      assignee:   (rawFields.assignee as any) ? {
        displayName: (rawFields.assignee as any).displayName,
        accountId:   (rawFields.assignee as any).accountId
      } : null,
      reporter:   (rawFields.reporter as any) ? {
        displayName: (rawFields.reporter as any).displayName,
        accountId:   (rawFields.reporter as any).accountId
      } : null,
      issuelinks: (rawFields.issuelinks as any[]) ?? [],
      status:     (rawFields.status as any)?.name ?? null,
      priority:   (rawFields.priority as any)?.name ?? null,
      duedate:    rawFields.duedate ?? null,
    }
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
      relation: raw.relation ?? null,
      directed: raw.directed ?? false,
      last_actor: raw.last_actor ?? null,
      due_at: raw.due_at ?? null,
      raw: { ...scrubRaw(raw.raw, ['id', 'key', 'self', 'issuetype', 'status', 'updated', 'created']), fields: curatedFields }
    }
  }

  return { surface, serverName, isAvailable, poll, normalize }
}

// ─── Slack CSV parser ─────────────────────────────────────────────────────────
// The slack-mcp-server returns conversations_search_messages results as RFC 4180
// CSV (via gocsv), not JSON. Parse into an array of row objects keyed by header.

function parseCsvRow(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field — consume until the closing unescaped quote
      let field = ''
      i++ // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            field += '"' // escaped quote
            i += 2
          } else {
            i++ // skip closing quote
            break
          }
        } else {
          field += line[i++]
        }
      }
      fields.push(field)
      if (i < line.length && line[i] === ',') i++ // skip field separator
    } else {
      // Unquoted field — read up to the next comma
      const commaIdx = line.indexOf(',', i)
      if (commaIdx === -1) {
        fields.push(line.slice(i))
        break
      } else {
        fields.push(line.slice(i, commaIdx))
        i = commaIdx + 1
      }
    }
  }
  return fields
}

function parseSlackCsv(csv: string): Record<string, string>[] {
  const lines = csv.trim().split('\n')
  if (lines.length < 2) return []
  const headers = parseCsvRow(lines[0])
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const fields = parseCsvRow(line)
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h.trim()] = fields[idx] ?? '' })
    rows.push(row)
  }
  return rows
}

// ─── Slack adapter ────────────────────────────────────────────────────────────

function makeSlackAdapter(): SurfaceAdapter {
  const surface: IntentSurface = 'slack'
  const serverName = 'slack'

  function isAvailable(): boolean {
    return getServerStatus().some((s) => s.name === serverName && s.connected)
  }

  async function poll(): Promise<{ observations: RawObservation[]; complete: boolean }> {
    const obs: RawObservation[] = []
    const COUNT = 20
    let truncated = false
    try {
      const ownerHandles = getOwnerHandles()
      // Slack search syntax: to:<handle> matches DMs and @mentions in channels.
      // Falls back to "to:me" when no handles are configured.
      const searchQuery = ownerHandles.length > 0
        ? ownerHandles.map(h => `to:${h}`).join(' OR ')
        : 'to:me'

      const result = await callTool(serverName, 'conversations_search_messages', {
        search_query: searchQuery,
        limit: COUNT
      })

      // The server returns CSV (gocsv RFC 4180 format) with a header row.
      // Columns: msgID, channelID, ThreadTs, text, permalink, userUser, userID, time
      const rows = parseSlackCsv(result)
      if (rows.length >= COUNT) truncated = true

      for (const row of rows) {
        const ts = row.msgID ?? ''
        const channelId = row.channelID ?? ''
        const author = row.userUser || row.userID || ''
        const isDm = channelId.startsWith('D')
        const threadTs = row.ThreadTs || null

        // Structural relation detection — no body storage needed for this logic
        const titleText = row.text ?? ''
        const mentionsOwner = ownerHandles.some((h) =>
          titleText.toLowerCase().includes(`@${h.toLowerCase()}`) ||
          titleText.toLowerCase().includes(h.toLowerCase())
        )

        let relation: string
        if (isDm) {
          relation = 'dm'
        } else if (mentionsOwner) {
          relation = 'mentioned'
        } else if (threadTs) {
          relation = 'thread_reply'
        } else {
          relation = 'involved'
        }

        // directed: someone else sent a DM, mentioned, or replied in a thread
        const directed = !isOwnerHandle(author) && relation !== 'involved'

        // row.time is ISO RFC3339 from the server; fall back to parsing ts as Slack epoch seconds
        let occurredAt: string | null = null
        if (row.time) { try { occurredAt = new Date(row.time).toISOString() } catch {} }
        if (!occurredAt && ts) { try { occurredAt = new Date(parseFloat(ts) * 1000).toISOString() } catch {} }

        obs.push({
          external_id: `${channelId}:${ts}`,
          kind: 'message',
          title: titleText.slice(0, 200),
          body: '', // Slack body not stored at rest (privacy)
          actor: author,
          url: row.permalink ?? '',
          occurred_at: occurredAt,
          relation,
          directed,
          last_actor: author || null,
          due_at: null,
          change_fields: { ts, channel: channelId },
          raw: { ts, channel: channelId, threadTs, userUser: author, userID: row.userID ?? '' }
        })
      }
    } catch (e) {
      console.warn('[ingestion:slack] poll failed:', e)
      truncated = true  // treat poll failure as potentially truncated
    }
    return { observations: obs, complete: !truncated }
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
      relation: raw.relation ?? null,
      directed: raw.directed ?? false,
      last_actor: raw.last_actor ?? null,
      due_at: raw.due_at ?? null,
      raw: scrubRaw(raw.raw, ['ts', 'channel', 'threadTs', 'userUser', 'userID'])
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

// ─── Freshness tracking ───────────────────────────────────────────────────────
// Records the ISO timestamp of the last fully-complete, error-free poll per surface.
// "Complete" means no query hit its pagination limit (so absence == true absence).
// Used by revalidatePendingIntents() in ambient.ts to detect disappeared work items.
const lastCompletePollAt = new Map<IntentSurface, string>()

/** Returns the ISO timestamp of the last complete poll for the given surface, or null. */
export function getLastCompletePollAt(surface: IntentSurface): string | null {
  return lastCompletePollAt.get(surface) ?? null
}

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
  lastCompletePollAt.clear()
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
  let pollComplete = false
  try {
    const { observations, complete } = await adapter.poll()
    pollComplete = complete
    for (const obs of observations) {
      const input = adapter.normalize(obs)
      const { inserted, id } = dbInsertSignal(input)
      if (inserted && id) {
        newSignals.push({
          id,
          ...input,
          observed_at: new Date().toISOString(),
          processed: false,
          last_seen_at: new Date().toISOString()
        })
      }
    }
  } catch (e) {
    console.error(`[ingestion:${adapter.surface}] poll error:`, e)
  }
  if (pollComplete) {
    // Record that we completed a full, non-truncated poll for this surface.
    // revalidatePendingIntents() uses this to safely infer item disappearance.
    lastCompletePollAt.set(adapter.surface, new Date().toISOString())
  }
  if (newSignals.length > 0) {
    console.log(`[ingestion:${adapter.surface}] ${newSignals.length} new signal(s)`)
    newSignalCallback?.(newSignals)
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
