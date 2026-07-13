import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'fs'
import { join, relative, extname, sep } from 'path'
import { createHash } from 'crypto'
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

    // If the user has configured GitHub scope, restrict queries to those orgs only.
    // GitHub treats multiple org: qualifiers as OR, so this is a union of allowed orgs.
    // When allowedOrgs is empty there is no filter — all orgs pass through (backward compatible).
    const allowedOrgs: string[] = readConfig().scope?.allowed?.github ?? []
    const orgFilter = allowedOrgs.length > 0
      ? ' ' + allowedOrgs.map((o) => `org:${o}`).join(' ')
      : ''

    const QUERIES: Array<{ q: string; relation: string; kind: 'pr' | 'issue' | 'both' }> = [
      { q: `is:open is:pr review-requested:@me${orgFilter}`,  relation: 'review_requested', kind: 'pr' },
      { q: `is:open assigned:@me${orgFilter}`,                 relation: 'assigned',         kind: 'both' },
      { q: `is:open mentions:@me${orgFilter}`,                 relation: 'mentioned',        kind: 'both' },
      { q: `is:open involves:@me${orgFilter}`,                 relation: 'involved',         kind: 'both' },
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

      // directed: review requests, assignments, and mentions are always directed at me;
      // for other relations (involved), fall back to last commenter being a non-owner
      const directed =
        relation === 'review_requested' ||
        relation === 'assigned' ||
        relation === 'mentioned' ||
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
        'updated_at', 'created_at', 'repository', 'repository_url', 'user',
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
        // watcher = currentUser() is omitted: it is frequently invalid on Jira Server/DC
        // and would reject the entire query, silently producing zero signals.
        jql: 'assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC',
        // mcp-atlassian maps the 'comment' field request to the top-level 'comments' array
        fields: 'summary,status,assignee,reporter,updated,created,comment,duedate,priority,issuelinks',
        limit: LIMIT
      })
      const parsed = safeParseJson<{ issues?: unknown[] }>(result, {})
      if ((parsed.issues?.length ?? 0) >= LIMIT) truncated = true
      const ownerHandles = getOwnerHandles()

      for (const issue of parsed.issues ?? []) {
        const i = issue as Record<string, unknown>
        // mcp-atlassian returns a flat simplified dict — all fields at top level with snake_case keys.
        // There is no nested 'fields' wrapper; sub-objects use snake_case (display_name, not displayName).
        const assignee = (i.assignee as any) ?? {}
        const reporter = (i.reporter as any) ?? {}

        // Determine relation: assignee == me → assigned, else → mentioned
        const assigneeDisplay = String(assignee.display_name ?? '')
        const assigneeAccount = String(assignee.name ?? '')  // 'name' = username/key
        const isAssigned = ownerHandles.length > 0 && ownerHandles.some((h) =>
          assigneeDisplay.toLowerCase().includes(h.toLowerCase()) ||
          assigneeAccount.toLowerCase().includes(h.toLowerCase())
        )
        const relation = isAssigned ? 'assigned' : 'mentioned'

        // Latest comment author — top-level 'comments' array (not fields.comment.comments)
        const comments: any[] = Array.isArray(i.comments) ? i.comments : []
        const lastComment = comments.length > 0 ? comments[comments.length - 1] : null
        const lastCommentAuthor = String(lastComment?.author?.display_name ?? '')
        const lastActor = lastCommentAuthor || null
        const directed = relation === 'assigned' ||
          (lastActor !== null && !isOwnerHandle(lastActor))

        // Body from latest comment — helps REQUEST_PATTERNS and context assembly
        const latestCommentBody = lastComment ? String(lastComment.body ?? '').slice(0, 500) : ''

        obs.push({
          external_id: String(i.key ?? i.id ?? ''),
          kind: 'issue',
          title: String(i.summary ?? ''),
          body: latestCommentBody,
          actor: String(assigneeDisplay || reporter.display_name || ''),
          url: (() => {
          const raw = String(i.url ?? '')
          if (raw) return raw
          // mcp-atlassian often omits the url field on simplified dicts; reconstruct from config.
          const key = String(i.key ?? i.id ?? '')
          if (!key) return ''
          const jiraBaseUrl = readConfig().mcp_servers?.find((s) => s.name === 'jira')?.env?.JIRA_URL
          if (!jiraBaseUrl) return ''
          return `${jiraBaseUrl.replace(/\/$/, '')}/browse/${key}`
        })(),
          occurred_at: String(i.updated ?? i.created ?? ''),
          relation,
          directed,
          last_actor: lastActor,
          due_at: i.duedate ? String(i.duedate) : null,
          change_fields: {
            status: (i.status as any)?.name,
            updated: i.updated,
            // last_comment_id is the fingerprint key for new comments: it changes on each
            // new comment regardless of pagination (the API always returns the latest comments).
            last_comment_id: lastComment?.id ?? null,
            last_actor: lastActor,
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
    // Build a curated fields sub-object so graph derivation (assignee, issuelinks) works.
    // mcp-atlassian returns a flat simplified dict (no nested 'fields' key); read top-level
    // keys directly. memory-graph.ts expects raw.fields.assignee.{displayName, accountId}
    // so we map snake_case → camelCase here to keep that contract stable.
    const flat = raw.raw as Record<string, unknown>
    const assigneeRaw = (flat.assignee as any)
    const reporterRaw = (flat.reporter as any)
    const curatedFields = {
      assignee: assigneeRaw ? {
        displayName: assigneeRaw.display_name ?? null,
        accountId:   assigneeRaw.name ?? null,   // 'name' = username/key in simplified dict
      } : null,
      reporter: reporterRaw ? {
        displayName: reporterRaw.display_name ?? null,
        accountId:   reporterRaw.name ?? null,
      } : null,
      issuelinks: [],  // mcp-atlassian simplified dict does not expose issuelinks
      status:     (flat.status as any)?.name ?? null,
      priority:   (flat.priority as any)?.name ?? null,
      duedate:    flat.duedate ?? null,
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
      raw: { ...scrubRaw(raw.raw, ['id', 'key', 'url', 'summary', 'status', 'updated', 'created']), fields: curatedFields }
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
    // Normalize header keys to lowercase so PascalCase Go field names (MsgID, Channel…)
    // and any other casing convention map to the same accessor.
    headers.forEach((h, idx) => { row[h.trim().toLowerCase()] = fields[idx] ?? '' })
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

      // The server (korotovsky/slack-mcp-server) returns RFC 4180 CSV with a header row.
      // Headers are Go exported field names (PascalCase): MsgID, Channel, UserName, UserID,
      // RealName, ThreadTs, Text, Time, Permalink. parseSlackCsv normalizes them to lowercase
      // so all reads use the lowercased form (msgid, channel, username, threadts, text…).
      const rows = parseSlackCsv(result)
      if (rows.length >= COUNT) truncated = true

      for (const row of rows) {
        const ts = row.msgid ?? ''
        const channelId = row.channel ?? ''
        const author = row.username || row.userid || ''
        const isDm = channelId.startsWith('D')
        const threadTs = row.threadts || null

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
          raw: { ts, channel: channelId, threadTs, username: author, userid: row.userid ?? '' }
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
      raw: scrubRaw(raw.raw, ['ts', 'channel', 'threadTs', 'username', 'userid'])
    }
  }

  return { surface, serverName, isAvailable, poll, normalize }
}

// ─── Linear adapter ──────────────────────────────────────────────────────────

/** Parse the plain-text output of linear_get_user_issues into structured objects. */
function parseLinearIssueText(text: string): Array<{
  identifier: string
  title: string
  status: string
  priority: string
  url: string
}> {
  const issues: Array<{ identifier: string; title: string; status: string; priority: string; url: string }> = []
  // Each issue block starts with "- IDENTIFIER: title" after a newline boundary.
  const blocks = text.split(/(?=\n- [A-Z0-9]+-\d+:)/)
  for (const block of blocks) {
    const lines = block.replace(/^\n/, '').split('\n')
    const firstLine = lines[0].replace(/^-\s+/, '').trim()
    const idMatch = firstLine.match(/^([A-Z0-9]+-\d+):\s*(.+)$/)
    if (!idMatch) continue
    const identifier = idMatch[1]
    const title = idMatch[2].trim()
    let status = ''
    let priority = ''
    let url = ''
    for (const line of lines.slice(1)) {
      const statusMatch = line.match(/Status:\s*(.+)/)
      if (statusMatch) status = statusMatch[1].trim()
      const priorityMatch = line.match(/Priority:\s*(.+)/)
      if (priorityMatch) priority = priorityMatch[1].trim()
      const urlMatch = line.match(/(https?:\/\/\S+)/)
      if (urlMatch) url = urlMatch[1].trim()
    }
    issues.push({ identifier, title, status, priority, url })
  }
  return issues
}

function makeLinearAdapter(): SurfaceAdapter {
  const surface: IntentSurface = 'linear'
  const serverName = 'linear'

  function isAvailable(): boolean {
    return getServerStatus().some((s) => s.name === serverName && s.connected)
  }

  async function poll(): Promise<{ observations: RawObservation[]; complete: boolean }> {
    const obs: RawObservation[] = []
    const LIMIT = 30
    let truncated = false
    try {
      const result = await callTool(serverName, 'linear_get_user_issues', { limit: LIMIT })
      const issues = parseLinearIssueText(result)
      if (issues.length >= LIMIT) truncated = true

      for (const issue of issues) {
        obs.push({
          external_id: issue.identifier,
          kind: 'issue',
          title: issue.title,
          body: '',  // text output does not include body content
          actor: '',
          url: issue.url,
          occurred_at: null,
          relation: 'assigned',   // linear_get_user_issues returns the user's own issues
          directed: true,
          last_actor: null,
          due_at: null,
          change_fields: {
            status: issue.status,
            priority: issue.priority,
          },
          raw: {
            identifier: issue.identifier,
            status: issue.status,
            priority: issue.priority,
            url: issue.url
          }
        })
      }
    } catch (e) {
      console.warn('[ingestion:linear] poll failed:', e)
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
      body: '',
      actor: raw.actor,
      url: raw.url,
      occurred_at: raw.occurred_at,
      relation: raw.relation ?? null,
      directed: raw.directed ?? false,
      last_actor: null,
      due_at: null,
      raw: scrubRaw(raw.raw, ['identifier', 'status', 'priority', 'url'])
    }
  }

  return { surface, serverName, isAvailable, poll, normalize }
}

// ─── Obsidian vault adapter ───────────────────────────────────────────────────
// Ingests a local markdown vault (e.g. an Obsidian vault) as read-only knowledge
// context. Unlike the other adapters this reads the filesystem directly — there
// is no MCP server involved. Notes have no actor and are never "directed" at the
// owner, so vault signals never fire proactive triggers (see the surface filter
// in ambient.ts onNewSignals) and are never a proposable action surface
// (VALID_SURFACES in inference.ts intentionally omits 'obsidian').

const MAX_NOTE_BODY_CHARS = 4000

/** Recursively collects absolute paths of .md files under `dir`, skipping dotfiles/dirs
 *  (.obsidian, .git, etc.) and any path that turns out not to be a plain file/dir. */
function walkMarkdownFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, out)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(full)
    }
  }
  return out
}

/** Strips a leading YAML frontmatter block and pulls out its `tags` field, if any. */
function parseFrontmatter(content: string): { tags: string[]; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { tags: [], body: content }
  const fm = match[1]
  const body = content.slice(match[0].length)

  let tags: string[] = []
  const inlineMatch = fm.match(/^tags:\s*\[(.*)\]\s*$/m)
  const scalarMatch = fm.match(/^tags:\s*(\S.*)$/m)
  const listMatch = fm.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m)
  if (inlineMatch) {
    tags = inlineMatch[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  } else if (listMatch) {
    tags = listMatch[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
  } else if (scalarMatch) {
    tags = [scalarMatch[1].trim()]
  }
  return { tags, body }
}

/** Extracts unique [[wikilink]] target names (ignoring #heading / |alias suffixes). */
function extractWikilinkNames(body: string): string[] {
  const re = /\[\[([^\]#|]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
  const names = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const name = m[1].trim()
    if (name) names.add(name)
  }
  return [...names]
}

/** First H1 heading, falling back to the filename (without extension). */
function extractTitle(body: string, filename: string): string {
  const h1 = body.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : filename.replace(/\.md$/i, '')
}

function makeObsidianAdapter(): SurfaceAdapter {
  const surface: IntentSurface = 'obsidian'
  const serverName = '' // no MCP server — reads the local filesystem directly

  function isAvailable(): boolean {
    const vault = readConfig().knowledge?.vault
    if (!vault?.enabled || !vault.path || vault.folders.length === 0) return false
    return existsSync(vault.path)
  }

  async function poll(): Promise<{ observations: RawObservation[]; complete: boolean }> {
    const vault = readConfig().knowledge?.vault
    if (!vault?.enabled || !vault.path || vault.folders.length === 0) {
      return { observations: [], complete: true }
    }

    // Dedup via Set: overlapping selections (e.g. both "Work" and "Work/Sub" checked)
    // would otherwise walk some files twice.
    const filesRaw: string[] = []
    for (const folder of vault.folders) {
      const abs = join(vault.path, folder)
      if (existsSync(abs)) walkMarkdownFiles(abs, filesRaw)
    }
    const files = [...new Set(filesRaw)]

    // Name index for wikilink resolution: Obsidian links by note basename (no
    // extension), case-insensitively. Two notes sharing a basename are ambiguous —
    // first match wins. This is context enrichment, not an authoritative resolver.
    const relPaths = new Map<string, string>() // absolute path -> vault-relative path (POSIX)
    const nameIndex = new Map<string, string>() // lowercase basename -> vault-relative path
    for (const abs of files) {
      const rel = relative(vault.path, abs).split(sep).join('/')
      relPaths.set(abs, rel)
      const base = rel.split('/').pop()!.replace(/\.md$/i, '').toLowerCase()
      if (!nameIndex.has(base)) nameIndex.set(base, rel)
    }

    let truncated = false
    const obs: RawObservation[] = []
    for (const abs of files) {
      const rel = relPaths.get(abs)!
      try {
        const raw = readFileSync(abs, 'utf8')
        const { tags, body } = parseFrontmatter(raw)
        const title = extractTitle(body, rel.split('/').pop()!)
        const wikilinks = extractWikilinkNames(body)
          .map((name) => nameIndex.get(name.split('/').pop()!.replace(/\.md$/i, '').toLowerCase()))
          .filter((p): p is string => !!p && p !== rel)
        const stat = statSync(abs)
        const folder = vault.folders.find((f) => rel === f || rel.startsWith(`${f}/`)) ?? vault.folders[0]

        obs.push({
          external_id: rel,
          kind: 'note',
          title,
          body: body.trim().slice(0, MAX_NOTE_BODY_CHARS),
          actor: '',
          url: `file://${abs}`,
          occurred_at: stat.mtime.toISOString(),
          relation: null,
          directed: false,
          last_actor: null,
          due_at: null,
          // Fingerprint key: a content hash (so a note re-processes only when its own
          // text changes — Obsidian rewrites mtime on every vault re-index) PLUS the
          // resolved wikilinks list. Without the latter, a note whose [[link]] target
          // didn't exist yet at ingest time would never re-resolve once the target
          // note is created, since the note's own text (and therefore its hash) never
          // changed — dbInsertSignal no-ops on an unchanged fingerprint and the freshly
          // re-resolved `wikilinks` value is discarded. Including the resolved list
          // means newly-resolvable (or newly-broken) links change the fingerprint,
          // so the row updates and deriveWikilinkEdges runs again.
          change_fields: {
            hash: createHash('sha256').update(body).digest('hex').slice(0, 16),
            wikilinks: [...wikilinks].sort()
          },
          raw: { tags, wikilinks, folder }
        })
      } catch (e) {
        console.warn(`[ingestion:obsidian] failed to read ${abs}:`, e)
        truncated = true
      }
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
      body: raw.body,
      actor: raw.actor,
      url: raw.url,
      occurred_at: raw.occurred_at,
      relation: null,
      directed: false,
      last_actor: null,
      due_at: null,
      raw: raw.raw
    }
  }

  return { surface, serverName, isAvailable, poll, normalize }
}

// ─── Polling scheduler ────────────────────────────────────────────────────────

export const adapters: SurfaceAdapter[] = [
  makeGithubAdapter(),
  makeJiraAdapter(),
  makeSlackAdapter(),
  makeLinearAdapter(),
  makeObsidianAdapter()
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
  slack: 40_000,
  linear: 60_000,
  obsidian: 80_000
}

const intervalIds = new Map<IntentSurface, ReturnType<typeof setInterval>>()
let newSignalCallback: ((signals: Signal[]) => void) | null = null

// Consecutive-failure backoff: a surface whose poll keeps throwing (expired
// token, rate limit, MCP server down) backs off geometrically instead of
// hammering the same failing call at full frequency forever. Resets to 0 on
// the next successful poll. Capped at MAX_BACKOFF_MULTIPLIER × the base interval.
const consecutiveFailures = new Map<IntentSurface, number>()
const MAX_BACKOFF_MULTIPLIER = 4

function backoffMultiplier(surface: IntentSurface): number {
  const failures = consecutiveFailures.get(surface) ?? 0
  return Math.min(2 ** failures, MAX_BACKOFF_MULTIPLIER)
}

// Bumped by stopIngestion() to invalidate any in-flight self-rescheduling
// chain from startIngestion(). Without this, a poll that's already awaiting
// adapter.poll() when stopIngestion() clears intervalIds would still
// unconditionally reschedule itself afterward — a "zombie" timer that
// clearInterval() can no longer see or cancel, silently resurrecting
// polling for that surface (and confusing startIngestion()'s
// `intervalIds.size > 0` re-entry guard on the next start).
let ingestionEpoch = 0

export function startIngestion(onNewSignals: (signals: Signal[]) => void): void {
  if (intervalIds.size > 0) return // already running
  newSignalCallback = onNewSignals
  const cfg = readConfig()
  const baseMs = cfg.ambient?.pollIntervalMs ?? 5 * 60 * 1000
  const epoch = ingestionEpoch

  for (const adapter of adapters) {
    const stagger = STAGGER_OFFSETS[adapter.surface]

    // Self-rescheduling setTimeout (rather than setInterval) so each poll's
    // backoff multiplier can change the delay before the *next* poll.
    const scheduleNext = (delay: number): void => {
      const id = setTimeout(async () => {
        if (epoch !== ingestionEpoch) return // stopIngestion() ran since this chain started
        await runAdapterPoll(adapter).catch(console.error)
        if (epoch !== ingestionEpoch) return // stopIngestion() ran during the poll
        const jitter = Math.floor(Math.random() * 90_000) - 45_000 // ±45 s
        const nextDelay = Math.max(baseMs * backoffMultiplier(adapter.surface) + jitter, 30_000)
        scheduleNext(nextDelay)
      }, delay)
      intervalIds.set(adapter.surface, id as unknown as ReturnType<typeof setInterval>)
    }

    const initialJitter = Math.floor(Math.random() * 90_000) - 45_000
    // Delay the first poll by the stagger so MCP connections can settle
    scheduleNext(Math.max(stagger + 3_000 + initialJitter, 3_000)) // +3 s minimum before first poll
  }
}

export function stopIngestion(): void {
  ingestionEpoch++
  for (const id of intervalIds.values()) clearInterval(id)
  intervalIds.clear()
  newSignalCallback = null
  lastCompletePollAt.clear()
  consecutiveFailures.clear()
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
  let seenCount = 0
  try {
    const { observations, complete } = await adapter.poll()
    pollComplete = complete
    seenCount = observations.length
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
    consecutiveFailures.set(adapter.surface, 0)
  } catch (e) {
    console.error(`[ingestion:${adapter.surface}] poll error:`, e)
    consecutiveFailures.set(adapter.surface, (consecutiveFailures.get(adapter.surface) ?? 0) + 1)
  }
  if (pollComplete) {
    // Record that we completed a full, non-truncated poll for this surface.
    // revalidatePendingIntents() uses this to safely infer item disappearance.
    lastCompletePollAt.set(adapter.surface, new Date().toISOString())
  }
  // Always log poll completion so we can see which surfaces are actually polling
  // and how many signals are seen vs. new (newly fingerprint-changed).
  console.log(`[ingestion:${adapter.surface}] poll complete — ${seenCount} seen, ${newSignals.length} new${pollComplete ? '' : ' (truncated)'}`)
  if (newSignals.length > 0) {
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
