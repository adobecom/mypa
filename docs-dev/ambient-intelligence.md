# Ambient Intelligence

mypa runs a background loop that monitors external surfaces, builds a knowledge graph from the observations, and proposes actions (intents) for the user to approve or dismiss.

**Source files:**
- `src/main/services/ambient.ts` — polling loop
- `src/main/services/triggers.ts` — trigger evaluators
- `src/main/services/ingestion.ts` — signal ingestion pipeline
- `src/main/services/inference.ts` — intent generation
- `src/main/services/autonomy.ts` — trust tier engine
- `src/main/db/schema.ts` — `signals`, `intents`, `action_log`, `autonomy_policy`
- IPC: `ambient` namespace in `src/shared/types.ts`
- Renderer: `src/renderer/src/widget/components/AmbientFeed.tsx`, `IntentCard.tsx`, `DigestView.tsx`

---

## Overview

Two pipelines feed the same intent queue:

**Ambient pipeline** (signal-driven):
```
External APIs (GitHub / Jira / Slack)
          │
          ▼  poll every pollIntervalMs (default 5 min)
   ambient.ts / ingestion.ts
          │  dbInsertSignal — deduplicated by (surface, external_id)
          ▼
   signals table
          │  memory-graph.ts → ingestSignalIntoGraph
          ▼
   graph_nodes / graph_edges / node_signals
          │  triggers.ts evaluates TriggerKinds
          ▼
   inference.ts inferIntent()  → IntentObject
          │  filtered by confidence ≥ AmbientConfig.confidenceFloor (default 0.4)
          ▼
   ambient.ts routeIntent()
          │  resolveTier → dbCreateIntent → graph node → dbAppendActionLog → handleIntent
          ▼
   intents table
          │
          ├──► renderer: widget Ambient tab (IntentCard)
          ├──► push event: ambient:intent-created
          └──► tray state: 'has-something' or 'needs-you'
```

**Routine pipeline** (schedule-driven, Phase B):
```
cron.ts fires → routines.ts executeRoutine()
          │
          ├─1─ MCP tools → rawOutput
          ├─2─ generateRoutineDigest → digest card + chat thread
          ├─3─ inference.ts inferRoutineIntents(name, rawOutput)
          │         → up to 3 IntentObjects (JSON array, one Claude call)
          └─4─ ambient.ts routeIntent() for each
                    → same tier/DB/graph/notify pipeline as ambient intents
                    → trigger_kind = 'routine'; context_packet links to routine node
```

---

## Configuration (`AmbientConfig`)

Stored in `AppConfig.ambient` (in `~/.mypa/config.json`):

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable / disable the polling loop |
| `pollIntervalMs` | `300000` (5 min) | How often to poll external surfaces |
| `decayHalfLifeDays` | `7` | Weight decay half-life for graph nodes and edges |
| `confidenceFloor` | `0.4` | Minimum confidence to surface an intent |
| `urgencyFloor` | `0.5` | Minimum urgency to surface an intent (separate from confidence; see urgency axis below) |
| `synthesisIntervalMs` | `1800000` (30 min) | How often the synthesis heartbeat re-evaluates "still waiting on me" items |

---

## Signals

A **signal** is a raw observed event from an external surface. Each signal is:
- Deduplicated by `UNIQUE(surface, external_id)` — the same GitHub PR won't create two rows.
- Fingerprinted — changes to the same item produce a new fingerprint, triggering re-processing.
- Marked `processed = 0` on insert; set to `1` after `ingestSignalIntoGraph` runs.
- Optionally embedded (local vector stored in `embedding` BLOB) for semantic similarity.

Supported surfaces: `github`, `jira`, `slack`.

---

## Trigger kinds (`TriggerKind`)

Evaluated by `triggers.ts` against the current graph state:

| Kind | Fires when |
|---|---|
| `waiting` | An item is structurally directed at the owner: review-requested, assigned, or a non-owner commented on something the owner is responsible for. **Primary trigger — fired first.** |
| `dependency` | A dependency or blocker edge connects to a node with recent activity |
| `spike` | A burst of new signals for the same surface+kind in a short window |
| `staleness` | A node the owner **owns** (assigned/review-requested) hasn't been updated in 48+ hours |
| `time` | A scheduled digest slot (morning / midday / eod) is due |
| `directed` | *(legacy, retired from event path)* — replaced by `waiting` |
| `threshold` | *(retired from autonomous path)* — metric proxy, no longer fires autonomously |
| `routine` | Fired by a routine run (not by the ambient poll loop) |

### Waiting-on-me trigger

The `waiting` trigger replaces the old `directed` trigger. It is **structurally-driven**, not regex-driven, which eliminates false positives from the old actor=original-author blind spot.

**Logic** (`evalWaitingOnMe` in `triggers.ts`):
1. For each new signal where `signal.directed === true` AND `signal.relation ∈ {review_requested, assigned, dm, thread_reply}`, emit a `TriggerHit { kind: 'waiting' }` with a human reason ("Sarah requested your review on PR #123").
2. For `mentioned` signals without a structural `directed` flag, fall back to REQUEST_PATTERNS regex as a secondary booster.
3. Capped at 3 hits per call; `coalesceHits` merges same-node duplicates.

**How `directed` is set in adapters:**
- GitHub: `review_requested` → always `directed=true`. Others: `directed = last_actor !== null && last_actor not in ownerHandles`. `last_actor` is the author of the most recent comment, fetched per candidate item (up to 15 per poll, prioritized by relation). This fixes the actor=original-author blind spot.
- Jira: `directed = relation === 'assigned' || (last_actor !== null && last_actor not in ownerHandles)`. Latest comment author is extracted from the already-fetched `comment` field.
- Slack: `directed = author not in ownerHandles && relation !== 'involved'`. Structural detection from DM channel ID (starts with `D`), `@mention` in title, or `thread_ts`.

### Stale-and-mine trigger

The `staleness` trigger now restricts to items the owner **owns** (assigned or review-requested), rather than any high-weight node. This prevents nagging about other people's busy work.

**Logic** (`evalStaleAndMine`): runs `getStaleCandidates(3.0)`, then cross-references against signals with `relation IN ('assigned','review_requested')` to keep only nodes the owner is responsible for.

### Synthesis heartbeat

Staleness and waiting-on-me from the heartbeat path re-evaluate the **current state of persisted signals** (`dbGetDirectedSignals`) every `synthesisIntervalMs` (default 30 min), not just on new arrivals. This ensures items like a PR waiting on your review for 3 days resurface even when GitHub is quiet (no new signals arriving). The heartbeat uses the same `inferenceQueue` serialization as all other paths, so it never races with poll-driven cycles.

---

## Intents

An **intent** is a proposed action derived from trigger evaluation. Types:

| `IntentType` | Meaning |
|---|---|
| `action` | A concrete action the assistant wants to take (e.g. post a comment, create a branch) |
| `suggestion` | A softer recommendation the user should consider |
| `flag` | Something that needs the user's attention but no action is proposed |
| `digest` | A structured summary (morning / midday / eod digest) |

Each intent has:
- `confidence` — 0–1: how certain the LLM is this signal is real and worth attention; filtered against `confidenceFloor`.
- `urgency` — 0–1: how consequential it is that the user acts **now** (separate axis from confidence). Considers: someone is blocked/waiting on the user, deadline proximity (due_at), cost of delay, irreversibility. Filtered against `urgencyFloor`. Used to rank within a cycle so the most consequential item surfaces first.
- `reversibility` — `reversible` or `irreversible`; irreversible intents always require approval.
- `tier` — the trust tier at the time it was created (affects whether it runs automatically).
- `status` lifecycle: `pending → surfaced → approved / dismissed / challenged → executed / failed / expired`.

---

## Autonomy trust tiers

The trust tier system adapts over time based on the user's feedback. Each `action_type` has its own policy row in `autonomy_policy`.

| Tier | Behaviour |
|---|---|
| `0` | Fully automatic — execute without surfacing to the user |
| `1` | Notify — show in ambient feed, execute after short delay unless dismissed |
| `2` (default) | Require approval — surface in feed, wait for explicit approve/dismiss |
| `3` | Always approve — extra confirmation required (used for irreversible or high-impact actions) |

### Two-level tier resolution

`resolveTier(obj)` uses a two-level lookup:
1. **Per-`surface:verb` policy** — earned organically via approve/challenge interactions (e.g. `github:comment` at tier 1 after 5 consecutive approvals).
2. **Per-intent-type policy** — set by the user in Settings for a broad category (e.g. all `action` intents default to tier 2). This is the key written by `ambient.setTier` from the Settings autonomy controls.
3. **Hardcoded default** — tier 2.

The safety floor still applies: irreversible or `required_approval` intents can never be below tier 2. Tier 3 at either level is absolute.

### Tier drift

- **Promotion** (tier decreases): when `consecutive_approvals` reaches the threshold (5), the tier drops by one AND the streak is **reset to zero** so subsequent promotions also each require 5 approvals.
- **Demotion** (tier increases): a challenge resets the consecutive streak and bumps the tier up.
- **Locking**: `tier_locked = 1` prevents automatic drift; only a manual `setTier` call changes it.
- **Reset**: `resetTrust()` deletes all policy rows; each `action_type` reverts to tier 2 on next use.

### User actions

| Action | Effect |
|---|---|
| **Approve** | Execute the intent; increment `approvals` + `consecutive_approvals`; potentially promote tier |
| **Dismiss** | Mark intent dismissed; increment `dismissals`; reset consecutive streak |
| **Challenge** | Mark intent challenged with a reason; increment `challenges`; reset streak; potentially demote tier |
| **Suggest** | Open a multi-round re-proposal conversation; keeps the intent non-terminal so the user can iterate before finally approving, dismissing, or challenging |

### Suggest — multi-round re-proposal

The Suggest action allows the user to steer mypa's thinking before committing. It does not end the intent; the user can Suggest as many times as desired, then Approve/Dismiss/Challenge as normal.

**Flow:**
1. User opens Suggest on an actionable intent card; an embedded `ChatThread` appears.
2. Each user message is persisted to `intent_threads` and sent to `inference.reproposeIntent()`.
3. `reproposeIntent` injects the original `context_packet`, the current proposal, and the full conversation history into a system prompt, then calls `runClaudeWithMcp`.
4. `runClaudeWithMcp` wires the Claude CLI to all connected MCP servers with a **read-only allowlist** (tools whose names start with `get`/`list`/`search`/`read`/`fetch`/`view`/`find`/`show`/`describe`/`query`/`lookup`/`check`). This lets Claude look up extra context (e.g. current PR CI status, open comments) but never mutate anything — write tools are never pre-approved during Suggest.
5. Claude returns a `{ message, proposed_action }` JSON envelope; the assistant reply is persisted to `intent_threads`, and the intent's proposal fields (`verb`/`target`/`payload`/`rationale`/`confidence`/`reversibility`/`required_approval`) are updated in-place via `dbReproposeIntent`.
6. Intent status remains `surfaced`; no tier changes. `ambient:intent-updated` and `ambient:intent-message` are broadcast to both windows.
7. The user can repeat from step 2 indefinitely, then choose a terminal action.

---

## Digests

Digests are `IntentType = 'digest'` intents generated at three times per day:

| Slot | Typical time |
|---|---|
| `morning` | ~9 AM |
| `midday` | ~12 PM |
| `eod` | ~5 PM |

Each digest has three sections:
- `did` — actions completed since the last digest
- `watching` — items the assistant is tracking
- `decisions` — autonomy decisions taken automatically

Rendered in the widget's Ambient tab as `DigestView`.

---

## Tray state

The tray icon reflects the ambient state:

| `TrayState` | Icon state | When |
|---|---|---|
| `idle` | Normal | No pending intents |
| `has-something` | Badge / indicator | Pending intents or new digest available |
| `needs-you` | Alert indicator | High-confidence action or irreversible intent waiting for approval |

The renderer subscribes to the `ambient:tray-state` push channel to stay in sync.

---

## IPC (`ambient` namespace)

See [ipc.md](ipc.md) for full signatures. Quick reference:

| Method | Description |
|---|---|
| `getIntents()` | All pending/surfaced intents |
| `approve(id)` | Approve and (if tier allows) execute |
| `dismiss(id)` | Dismiss |
| `challenge(id, reason)` | Challenge with reason |
| `suggest(id, message)` | Send a Suggest message; returns updated `{intent, assistantMessage}` |
| `getIntentThread(id)` | Load the `ChatMessage[]` thread for an intent |
| `getDigest(slot?)` | Latest digest for a slot |
| `getTrayState()` | Current tray state |
| `getPolicy()` | All autonomy policies |
| `setTier(type, tier, locked?)` | Manual tier override |
| `resetTrust()` | Reset all policies |
| `pollNow()` | Trigger immediate poll |
| `getLog(limit?)` | Recent action log |

## Changelog

- 2026-06-15 — **Freshness revalidation — surface-agnostic intent expiry:** Queued intents (status `pending`/`surfaced`) now auto-expire when their underlying work item disappears from adapter poll results. The mechanism is deliberately surface-agnostic: it uses the universal signal that a closed PR, resolved Jira issue, un-assigned ticket, or handled Slack thread will simply stop appearing in the `is:open …@me` / assignee / mentions queries. `revalidatePendingIntents()` runs on the poll interval (default 5 min) and on every manual `ambientPollNow` call. Safeguards: (1) surface health gate — no expiry if the adapter has not recorded a complete, error-free poll; (2) pagination guard — `complete=false` when any query hit its page limit, blocking expiry for that surface; (3) 2-poll debounce — consecutive-miss counter in `intentMissCount`; (4) all-items rule — multi-focus intents only expire when every work-item signal is absent. On expiry: `dbUpdateIntentStatus(id, 'expired', reason)`, action log, `broadcast('ambient:intent-updated')`, tray refresh. The previously-declared `'expired'` status is now actively used for the first time.
- 2026-06-11 — **"Needs me" reframe across all surfaces:** Four-layer change to make ambient genuinely proactive during quiet periods. (1) *Data capture* — signals table gains `relation TEXT`, `directed INTEGER`, `last_actor TEXT`, `due_at TEXT`; intents table gains `urgency REAL`. GitHub adapter now runs role-tagged queries (`review-requested:@me`, `assigned:@me`, `mentions:@me`, `involves:@me`) with de-dup by priority; fetches the latest comment author per candidate (up to 15/poll) to fix the actor=original-author blind spot. Jira adapter fetches `duedate`/`priority`/`issuelinks`; latest comment body populates signal `body`; curated `fields` sub-object un-deads `deriveAssigneeEdges` and Jira dependency edges. Slack adapter detects DM/mention/thread_reply structurally; `directed` set from author≠owner without storing body. (2) *Consequence-based triggers* — new `evalWaitingOnMe` (structural, not regex) replaces `evalDirectedAtMe`; `evalStaleAndMine` restricts staleness to owner-assigned/review-requested nodes; `evalThreshold` retired from autonomous path; `evaluationCount % 6` gate deleted; `TriggerKind` gains `'waiting'`. (3) *Urgency axis + editorial bar* — `SYSTEM_PROMPT` and `ROUTINE_SYSTEM_PROMPT` gain `"urgency"` field with instruction to rate consequence-of-delay separately from confidence; `inferIntent`/`inferRoutineIntents` drop intents below `urgencyFloor` (default 0.5); `runAmbientCycle` refactored into infer-all → sort by (urgency, confidence) → take top-3 so the most important item wins rather than the first to arrive. (4) *Synthesis heartbeat* — `startSynthesisTimer`/`stopSynthesisTimer` in `ambient.ts` re-evaluate `evalWaitingOnMeFromGraph` + `evalStaleAndMine` every `synthesisIntervalMs` (default 30 min) from persisted signals, decoupled from new-signal arrival. Known gap: dismissed-but-not-acted items can resurface on the next heartbeat (pending-intent dedup covers only pending/surfaced status). Privacy: GitHub stores metadata-only (no new free text); Jira stores single latest comment body (capped 500 chars); Slack stores structural flags only, body remains `''`.
- 2026-06-10 — **Scope now self-derives from check-ins; registry-driven enforcement:** `scope.ts:violatesScope` logic (part_of traversal, conservative fallbacks) is unchanged. The enforcement mechanism is now registry-driven: it looks up the surface spec via `scopeSurfaceFor()` from `src/shared/scope-surfaces.ts` and calls `spec.parseIdentifier(key)`, eliminating the per-surface if/else. `ScopeConfig` reshaped to `{ allowed?: Record<string, string[]> }` — keyed by surface rather than three named fields; a migration shim handles any pre-existing config with named fields. Allowlists are populated automatically by `checkin.ts` during extraction (union semantics — never reduced) rather than via manual Settings input. The Scope card in Settings is now read-only.
- 2026-06-10 — **Hard-rule enforcement and scope filter:** two enforcement layers added. (1) *Directive injection* — `config.ts` exports `buildDirectivesClause()`, which reads all active hard memories from the DB (`dbGetActiveHardMemories()`) and returns a trusted standing-directives block that is appended to inference system prompts (alongside `buildOwnerClause()`); hard memories are never rendered as advisory `<context>` data. (2) *Deterministic scope filter* — new `src/main/services/scope.ts` exports `violatesScope(obj, focusNodes): boolean`; it resolves each focus node's `part_of` container edges, extracts the org/project/channel key, and drops the intent if a configured allowlist for that surface exists and the container is not on it. Applied at both ambient chokepoints: `runAmbientCycle` (before `dbCreateIntent`) and `routeIntent` (same position). Conservative: when no container edges exist, the intent passes through. `AppConfig.scope` previously held `allowedGithubOrgs`, `allowedJiraProjects`, `allowedSlackChannels`; now replaced with the generic `allowed` map (see above).
- 2026-06-10 — **Suggest multi-round re-proposal:** added Suggest as a fourth non-terminal user action on actionable intents. New `intent_threads` table persists the conversation. `inference.reproposeIntent` builds a re-proposal prompt from the original `context_packet`, current proposal, and conversation history, then calls `runClaudeWithMcp` — which wires the Claude CLI to connected MCP servers with a read-only tool allowlist (name-prefix filter) so Claude can look up extra context without ever mutating data. The assistant reply and updated `IntentObject` fields are stored; the intent stays `surfaced` for further Suggest rounds. `ambient:intent-message` push channel added; `ambient.suggest` / `ambient.getIntentThread` IPC methods added. The Suggest thread is rendered in `IntentCard` via the shared `ChatThread` component in both the widget and main-window Insights page.
- 2026-06-09 — **informational intent muting:** added `isMuted(type, tier)` predicate to `autonomy.ts`; informational intents (`flag`/`digest`/`suggestion`) whose resolved tier is 3 are now dropped before `dbCreateIntent` in both `runAmbientCycle` and `routeIntent` — they produce no DB row, no graph node, and no action-log entry. This is the backend effect of the user setting an informational type to "Mute" in the Ambient Autonomy card. `action`-type intents at tier 3 remain unaffected (still surfaced as Locked flags). The `autonomy_policy` table stores the mute as `tier=3` for the intent type key, reusing the existing `ambient:set-tier` IPC channel with no schema changes.
- 2026-06-09 — **intent graduation to plan (Phase C):** on successful `executeIntent`, `ambient.ts` now calls `dbCreateAmbientActionRecord(intent)` to create a `PlanItem(status:'done', source:'ambient_action')` as a durable record of what the agent did. The widget's Queue "Done" section naturally includes these records alongside user-completed tasks. Badge count is refreshed via `updateBadgeCount()` after creation so the widget refreshes its plan list. Failures in the graduation step are non-fatal — the intent's own `executed` status is unaffected.
- 2026-06-09 — **macOS Dock badge:** `windows.updateBadgeCount()` now calls `app.setBadgeCount(n)` so the Dock icon shows a numeric red badge equal to `pendingRuns + pendingItems + pendingIntents`. Distinct from the tray red dot (which requires a tier ≥ 2 approval-required action intent): Dock = total pending count, tray = explicit user action required. Badge is set on startup and updated on every count-changing event.
- 2026-06-09 — **routines as action generators (Phase B):** `executeRoutine` now runs `inferRoutineIntents(name, rawOutput)` after the digest step, producing up to 3 `IntentObject`s from one Claude call. Each result is routed through `ambient.routeIntent()` with `trigger_kind:'routine'` so routine-generated action candidates appear in the widget queue alongside ambient intents, use the same tier/trust engine, and appear in the main-window Activity page. `TriggerKind` extended with `'routine'`. The digest card and chat thread are preserved.
- 2026-06-09 — **action-centric redesign (Phase A):** inference `SYSTEM_PROMPT` now strongly prefers `type:"action"` over `suggestion`/`flag`; instructs the model to draft the full artifact text into `payload.body`/`message` so the user gets an editable draft rather than a vague suggestion. `suggestion` type is no longer emitted (kept in `VALID_TYPES` for backwards compat with stored intents). Triage split: only `action`-type intents fire OS notifications, update the badge, and drive tray state; informational intents (`flag`/`digest`) are still stored and pushed via `broadcast` to both windows but do not interrupt the user. `pushIntent` now uses `broadcast()` (all windows) instead of widget-only send, so the new main-window Activity page receives all intents. `ambientApproveIntent` accepts an optional `payload` arg and persists the user-edited draft via `dbUpdateIntentPayload` before executing.
- 2026-06-08 — added `directed` trigger kind (`evalDirectedAtMe`); fires on single inbound signals from non-owner actors containing question/request language; documented autonomy path for "reply on my behalf" PM use case
- 2026-06-07 — `executeIntent` now calls `broadcast('ambient:action-executed', intent)` after a tier-0 intent succeeds, so the main window can surface a toast; `ambient.ts` imports `broadcast` from `../windows`
- 2026-06-07 — `inferIntent` now appends the owner-identity clause to its system prompt (via `buildOwnerClause`); `renderPacketForPrompt` tags owner person-nodes as `you (handle)` in relationship and focus lines when `AppConfig.owner.handles` is configured
- 2026-06-07 — trust two-level tier resolution: `resolveTier` falls back to intent-type policy (Settings controls) when no per-surface:verb policy exists; streak is reset on tier promotion to ensure each step costs the full threshold; Settings UI now does exact `action_type` match instead of fragile `startsWith`
- 2026-06-06 — initial documentation
