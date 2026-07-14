# Ambient Intelligence

mypa runs a background loop that monitors external surfaces, builds a knowledge graph from the observations, and proposes actions (intents) for the user to approve or dismiss.

**Source files:**
- `src/main/services/ambient.ts` — polling loop
- `src/main/services/triggers.ts` — trigger evaluators
- `src/main/services/ingestion.ts` — signal ingestion pipeline
- `src/main/services/inference.ts` — intent generation
- `src/main/services/autonomy.ts` — trust tier engine
- `src/main/db/schema.ts` — `signals`, `graph_nodes`, `graph_edges`, `node_signals`, `memories`, `intent_threads`, `intents`, `action_log`, `autonomy_policy`
- IPC: `ambient` namespace in `src/shared/types.ts`
- Renderer: `src/renderer/src/widget/components/IntentCard.tsx`, `DigestView.tsx`, `QueueView.tsx`; `src/renderer/src/main-window/components/InsightsPage.tsx`

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
| `urgencyFloor` | `0.5` | Minimum urgency for `spike`/`dependency`/`time` triggers (see per-kind floor below) |
| `waitingUrgencyFloor` | `0.25` | Minimum urgency for `waiting`/`staleness` triggers — these items are real-but-not-urgent by design |
| `synthesisIntervalMs` | `3600000` (60 min) | How often the synthesis heartbeat repeats after the first tick |
| `synthesisInitialDelayMs` | `75000` (75 s) | Delay before the **first** heartbeat tick after boot (lands after all three adapter stagger offsets settle) |
| `dailyBudgetUsd` | `2.0` | Daily USD spend cap (all sources/models) above which deep-enrichment is skipped for the rest of the day, falling back to lightweight inference. `0` disables the cap. See `budget.ts`. |

---

## Signals

A **signal** is a raw observed event from an external surface. Each signal is:
- Deduplicated by `UNIQUE(surface, external_id)` — the same GitHub PR won't create two rows.
- Fingerprinted — changes to the same item produce a new fingerprint, triggering re-processing.
- Marked `processed = 0` on insert; set to `1` after `ingestSignalIntoGraph` runs.
- Optionally embedded (local vector stored in `embedding` BLOB) for semantic similarity.

Supported surfaces: `github`, `jira`, `slack`, `linear`.

### Adding a new surface (three-touchpoint recipe)

To wire a new MCP server as a first-class surface (with ingestion reads and ambient auto-writes), update these three files in the same commit:

1. **`src/shared/types.ts`** — add the new name to `IntentSurface`.

2. **`src/main/services/ingestion.ts`** — implement `makeXxxAdapter(): SurfaceAdapter`:
   - `surface: IntentSurface` — the new name
   - `serverName` — matches the name in `AppConfig.mcp_servers`
   - `isAvailable()` — checks `getServerStatus()`
   - `poll()` — calls a fixed read tool, parses the output into `RawObservation[]`, sets `complete = false` when truncated
   - `normalize(raw)` — maps `RawObservation` to `SignalInput`, calling `computeFingerprint` and `scrubRaw`
   - Add the adapter to the `adapters` array and add a `STAGGER_OFFSETS` entry (space stagger by 20 000 ms increments from the last surface)

3. **`src/main/services/ambient.ts`** — three spots:
   - `VERB_TO_TOOL` — add `{ surfaceName: { comment: 'tool_name', … } }` entries (read-only verbs go in `AUTO_EXECUTABLE` too; destructive verbs like `close`/`merge` deliberately excluded)
   - `enrichPayloadForRouting` — add a branch that injects `_`-prefixed routing IDs (issue key, channel ID, etc.) into `obj.proposed_action.payload` from `focusNodes` graph node keys (`surface:kind:id` format)
   - `buildToolArgs` — add a branch that maps `_`-prefixed payload fields and LLM-authored content into the correct MCP tool argument shape

**Deferral notes:** Notion is document-centric and a weaker intent fit (no inbox/assigned-item concept); defer wiring it as an ingestion surface. Postgres, brave-search, google-maps, memory, puppeteer, and filesystem are utility servers (no actionable signal stream); they remain chat/routine only.

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
- GitHub: `review_requested`, `assigned`, and `mentioned` → always `directed=true`. For `involved` signals: `directed = last_actor !== null && last_actor not in ownerHandles`. `last_actor` is the author of the most recent comment, fetched per candidate item (up to 15 per poll, prioritized by relation). This fixes the actor=original-author blind spot.
- Jira: `directed = relation === 'assigned' || (last_actor !== null && last_actor not in ownerHandles)`. Latest comment author is extracted from the already-fetched `comment` field.
- Slack: `directed = author not in ownerHandles && relation !== 'involved'`. Structural detection from DM channel ID (starts with `D`), `@mention` in title, or `thread_ts`.

### Stale-and-mine trigger

The `staleness` trigger now restricts to items the owner **owns** (assigned or review-requested), rather than any high-weight node. This prevents nagging about other people's busy work.

**Logic** (`evalStaleAndMine`): runs `getStaleCandidates(3.0)`, then cross-references against signals with `relation IN ('assigned','review_requested')` to keep only nodes the owner is responsible for.

### Synthesis heartbeat

Staleness and waiting-on-me from the heartbeat path re-evaluate the **current state of persisted signals** (`dbGetDirectedSignals`) at two intervals:
- **Initial tick:** ~75 s after boot (`synthesisInitialDelayMs`), landing after all three adapter stagger offsets complete (+3 s github / +23 s jira / +43 s slack), so the DB is populated before the first evaluation. This surfaces items already waiting on the user immediately at startup rather than after the full interval.
- **Recurring ticks:** every `synthesisIntervalMs` (default 60 min) thereafter.

The heartbeat uses the same `inferenceQueue` serialization as all other paths, so it never races with poll-driven cycles. It also writes one `diag` action-log row per tick (see **Observability** below), so the user can query the pipeline state via `ambient.getLog()` without grepping console output.

---

## Intents

An **intent** is a proposed action derived from trigger evaluation. Types:

| `IntentType` | Meaning |
|---|---|
| `action` | A concrete action the assistant wants to take (e.g. post a comment, create a branch) |
| `suggestion` | A softer recommendation the user should consider |
| `flag` | Something that needs the user's attention but no action is proposed |
| `digest` | A structured summary (morning / midday / eod digest) |

An `action` intent's `verb` is usually a comment/label/review/message verb executed via `executeIntent`/`executeActions` (`ambient.ts`) — but `verb: 'author_fix'` is a different, parallel lifecycle: it means "attempt a real code change," not "call an MCP tool." See [code-authoring.md](code-authoring.md) for the full flow — `inferDeepIntent` (`inference.ts`) tries this path first, before the usual comment/review proposal, whenever a directed item's container resolves to a linked, authoring-enabled repo. `author_fix` intents are surfaced and tiered exactly like any other action intent; only the Start/Ship-it actions (`ambient.startAuthoring`/`shipWorkProduct`, driven by the widget's `WorkProductCard`) are a separate code path from `executeIntent`.

Each intent has:
- `confidence` — 0–1: how certain the LLM is this signal is real and worth attention; filtered against `confidenceFloor`.
- `urgency` — 0–1: how consequential it is that the user acts **now** (separate axis from confidence). Considers: someone is blocked/waiting on the user, deadline proximity (due_at), cost of delay, irreversibility. Filtered against a **per-kind urgency floor**: `waiting`/`staleness` triggers use `waitingUrgencyFloor` (default 0.25, lenient — these items are real but not time-critical by design); `spike`/`dependency`/`time` triggers use `urgencyFloor` (default 0.5, stricter — activity bursts should clear a higher bar). Used to rank within a cycle so the most consequential item surfaces first.
- `reversibility` — `reversible` or `irreversible`; irreversible intents always require approval.
- `tier` — the trust tier at the time it was created (affects whether it runs automatically).
- `status` lifecycle: `pending → surfaced → approved / dismissed / challenged → executed / failed / expired`.
- `cta_label` — an optional, LLM-authored short imperative button label for the proposed action (e.g. "Merge PR #482", "Post comment"), emitted alongside `proposed_action` in every `inference.ts` prompt variant. `IntentCard.tsx`'s primary approve button prefers this text over its built-in heuristic label (`buildActionCtaLabel`), which remains as the fallback for older intents or when the model omits it. `ProposedChatAction` (the in-chat action-chip type) carries the same field and `ChatThread.tsx`'s `ActionChip` Approve button is wired to prefer it too, but nothing currently constructs a *new* pending `ProposedChatAction` with a populated `cta_label` — only `dbCreateIntent`/`dbReproposeIntent` (the `Intent` path behind `IntentCard`) populate it today, so the `ActionChip` case is forward-compatible plumbing rather than active behavior.

---

## Autonomy trust tiers

The trust tier system adapts over time based on the user's feedback. Each `action_type` has its own policy row in `autonomy_policy`.

| Tier | Behaviour |
|---|---|
| `0` | Fully automatic — execute without surfacing to the user |
| `1` | Notify — show in ambient feed, execute after short delay unless dismissed |
| `2` (default) | Require approval — surface in feed, wait for explicit approve/dismiss |
| `3` | Locked — user-initiated only; agent never acts on its own. Must be set explicitly in Settings. Surfaced with full OS notification + dock badge, same as tiers 1 and 2. |

### Two-level tier resolution

`resolveTier(obj)` uses a two-level lookup:
1. **Per-`surface:verb` policy** — earned organically via approve/challenge interactions (e.g. `github:comment` at tier 1 after 5 consecutive approvals).
2. **Per-intent-type policy** — set by the user in Settings for a broad category (e.g. all `action` intents default to tier 2). This is the key written by `ambient.setTier` from the Settings autonomy controls.
3. **Hardcoded default** — tier 2.

The safety floor still applies: irreversible or `required_approval` intents can never be below tier 2. Tier 3 at either level is absolute — but it can only be reached by explicit user action in Settings, never by challenge feedback alone (see `AUTO_ESCALATE_CEILING` below).

### Tier drift

- **Promotion** (tier decreases): when `consecutive_approvals` reaches the threshold (5), the tier drops by one AND the streak is **reset to zero** so subsequent promotions also each require 5 approvals. Automatic trust accumulation floors at tier 1 (`AUTO_DECAY_FLOOR`) — reaching tier 0 (Silent) requires explicit user opt-in.
- **Demotion** (tier increases): a challenge resets the consecutive streak and bumps the tier up by one, capped at tier 2 (`AUTO_ESCALATE_CEILING`). Challenge feedback can never push a verb past Approve — reaching tier 3 (Locked) requires explicit user opt-in in Settings.
- **Locking**: `tier_locked = 1` means the tier was set explicitly via Settings; automatic drift (promotion or capped demotion) never overrides it. `setTier` writes `tier_locked = true` whenever tier 3 is set, so explicit Locks are always distinguishable from challenge drift (which caps at 2 and therefore always has `tier_locked = 0`).
- **Reset**: `resetTrust()` deletes all policy rows; each `action_type` reverts to tier 2 on next use.

### User actions

| Action | Effect |
|---|---|
| **Approve** | Execute the intent; increment `approvals` + `consecutive_approvals`; potentially promote tier |
| **Dismiss** | Mark intent dismissed; increment `dismissals`; reset consecutive streak |
| **Challenge** | Mark intent challenged with a reason; increment `challenges`; reset streak; potentially demote tier |
| **Chat** | Open a streaming conversation about this insight; an embedded `ChatThread` appears. The user can ask questions, get context, or ask Claude to revise the proposal via an opt-in "Update the proposal" button. |

### Chat — streaming conversation + opt-in re-proposal

The Chat panel provides a free-form streaming discussion surface for every intent, including failed and terminal ones. For active action intents it also offers a one-shot re-proposal path.

**Flow — chat:**
1. User opens Chat on any intent card; a `ChatThread` appears.
2. The user's message is persisted to `intent_chat_threads` and streamed via `handleIntentChat` → `streamChat`. The intent's `context_packet`, proposal, and error (if any) are attached as `rawContext` so Claude has the same situational awareness the inference layer had.
3. Claude replies in streaming chunks broadcast as `ambient:chat-message`. The final reply is persisted. The user can continue the conversation freely.

**Flow — "Update the proposal" (action intents only, once ≥1 assistant reply exists):**
1. After a conversation exchange, the user clicks "Update the proposal" inside the Chat panel.
2. `reviseIntentFromChat(id)` loads `intent_chat_threads` history and calls `inference.reproposeIntent()` with a synthetic instruction.
3. `reproposeIntent` injects the original `context_packet`, the current proposal, and the full chat history into its system prompt, then calls `runClaudeWithMcp` with a **read-only allowlist** (tools prefixed `get`/`list`/`search`/`read`/`fetch`/`view`/`find`/`show`/`describe`/`query`/`lookup`/`check`).
4. Claude returns a `{ message, proposed_action }` JSON envelope. If the revised proposal passes `confidenceFloor`/`urgencyFloor`, intent fields (`verb`/`target`/`payload`/`rationale`/`confidence`/`reversibility`/`required_approval`) are updated in-place via `dbReproposeIntent`. Below-floor proposals surface only the message.
5. The assistant reply is appended to the chat thread. `ambient:intent-updated` + `ambient:chat-message` broadcast to both windows.

---

## Digests

Digests are `IntentType = 'digest'` intents generated at three times per day:

| Slot | Typical time |
|---|---|
| `morning` | ~9 AM |
| `midday` | ~12 PM |
| `eod` | ~5 PM |

Each digest has three sections:
- `did` — actions completed since the last digest (intents with `status='executed'`)
- `watching` — items the assistant is tracking (intents with `status='surfaced'`)
- `decisions` — action intents with `required_approval=true` currently awaiting user approval (intents with `type='action'`, `status='surfaced'`, `required_approval=true`)

Rendered in the widget's Ambient tab as `DigestView`.

---

## Tray state

The tray icon reflects the ambient state:

| `TrayState` | Icon state | When |
|---|---|---|
| `idle` | Normal | No pending intents |
| `has-something` | Badge / indicator | Pending intents or new digest available |
| `needs-you` | Alert indicator | High-confidence action or irreversible intent waiting for approval |

The renderer subscribes to the `ambient:tray-state` push channel to stay in sync. Broadcast to both the widget and the main window (see [services.md](services.md#ambientts--ambient-polling-loop)), though today only the widget's `TabStrip` actually holds and displays a `TrayState` value — the main window receives the event but has no UI wired to it yet.

---

## IPC (`ambient` namespace)

See [ipc.md](ipc.md) for full signatures. Quick reference:

| Method | Description |
|---|---|
| `getIntents()` | All pending/surfaced intents |
| `getAllIntents(limit?)` | Full intent history (default limit 200) |
| `approve(id, payload?)` | Approve and (if tier allows) execute; optional `payload` persists a user-edited draft |
| `dismiss(id)` | Dismiss |
| `challenge(id, reason)` | Challenge with reason |
| `reviseFromChat(id)` | Trigger a one-shot re-proposal over the Chat thread; returns `{intent, applied, message}` |
| `getDigest(slot?)` | Latest digest for a slot |
| `getTrayState()` | Current tray state |
| `getPolicy()` | All autonomy policies |
| `setTier(type, tier, locked?)` | Manual tier override |
| `resetTrust()` | Reset all policies |
| `pollNow()` | Trigger immediate poll across all surfaces (awaits full cycle) |
| `getLog(limit?)` | Recent action log entries |

---

## Observability

The always-on pipeline emits diagnostic output at multiple levels to make stalls visible without requiring code changes.

### Console logs (always emitted)

| Location | Format | What it tells you |
|---|---|---|
| `ingestion.ts runAdapterPoll` | `[ingestion:github] poll complete — N seen, M new` (or `(truncated)`) | Whether each surface is actually polling and producing signals |
| `ambient.ts onNewSignals` | `[ambient] N new signal(s) — no trigger hits` | When new signals arrive but none fire a trigger |
| `ambient.ts runAmbientCycle` | `[ambient] cycle — H hit(s), C skipped (covered), D skipped (cooldown), I inferred, dropped: {...}` | Where the cycle ends: pending-covered suppression, resolution-cooldown suppression, and inference drops |
| `inference.ts inferIntent` | `[inference] dropped — below-confidence/below-urgency/verb-none` with `{conf, urg, kind}` | Exactly why each candidate was dropped |
| `ambient.ts runSynthesisHeartbeat` | `[ambient] synthesis heartbeat — N directed signal(s), W waiting hit(s), S stale hit(s), C coalesced hit(s)` | Census at every heartbeat tick |

### Diagnostic action-log rows

`runSynthesisHeartbeat` writes one `event: 'diag', action_type: 'heartbeat'` row to the action log per tick. The `detail` object contains:
```json
{ "directedSignals": N, "waitingHits": W, "staleHits": S, "totalHits": T }
```

These rows appear in `ambient.getLog()` interleaved with real `emitted`/`executed` events. Reading the last few rows tells you:

- `directedSignals: 0` despite open review-requests ⇒ adapter `directed` flag is not being set correctly (adapter bug in `ingestion.ts`)
- `directedSignals: N > 0, waitingHits: 0` ⇒ `buildWaitingHit` / `coalesceHits` issue in `triggers.ts`
- `waitingHits: N > 0, totalHits: 0` ⇒ all hits were skipped — either by the pending-covered check or the resolution-cooldown check in `runAmbientCycle`; look at the `C skipped (covered)` and `D skipped (cooldown)` counts in the cycle log to distinguish
- `totalHits: N > 0` but no `emitted` row follows ⇒ inference dropped every candidate; see the `dropped:` breakdown in the cycle console log

## Changelog

- 2026-07-14 — **LLM-authored CTA labels (`inference.ts`, `types.ts`, `db/schema.ts`, `db/index.ts`).** Every `IntentObject` JSON schema variant except the author-fix path (`SYSTEM_PROMPT`, `ROUTINE_SYSTEM_PROMPT`, `SUGGEST_SYSTEM_PROMPT`, `DEEP_SYSTEM_PROMPT`) now asks the model for an optional `cta_label` — a short imperative button label naming the concrete action (e.g. "Merge PR #482"), parsed by `parseIntentObject`/`parseDeepIntentObject` and persisted in the new `intents.cta_label` column (see [database.md](database.md#changelog)). `AUTHOR_FIX_SYSTEM_PROMPT` is intentionally excluded — `author_fix` intents render via `WorkProductCard`, not `IntentCard`'s primary button, so a `cta_label` there would never surface. `IntentCard.tsx`'s primary approve button prefers `cta_label` over its previous hardcoded/heuristic labels ("Approve", "Send", `buildActionCtaLabel`), which remain in place as a fallback. `ProposedChatAction`/`ChatThread.tsx`'s `ActionChip` also gained the field and a preference check, but no code path currently constructs a new pending `ProposedChatAction` with `cta_label` populated — that half of the change is forward-compatible plumbing, not yet active. Out of scope: `InlineToolApproval`'s mid-chat tool-approval popup, which gates raw MCP tool calls outside the `inference.ts` pipeline and keeps its static "Approve"/"Deny" text.

- 2026-07-14 — **`ambient:tray-state`/`ambient:digest-ready` now broadcast to both renderer windows (`ambient.ts`).** Previously sent only to the widget window; the main window never received them even when open, which was part of a wider renderer state-sync bug. See [services.md](services.md#ambientts--ambient-polling-loop).

- 2026-07-09 — **`author_fix` proposal path in `inferDeepIntent` (`inference.ts`).** Before the usual actions[] write-action proposal, deep enrichment now tries an author-fix decision: if the triggering item's container resolves to a linked, authoring-enabled repo (`repos.ts` `resolveRepoForNode`), a read-only call judges whether a coding agent could plausibly attempt the task and, if so, writes a self-contained `task_description`. On `proceed:true` this emits an `author_fix`-verb `action` intent instead of the normal comment/review proposal; `ambient.ts`'s tier resolution and surfacing are unmodified (`author_fix` gets the same `TYPE_DEFAULT_TIER['action'] = 2` as any other action intent). See [code-authoring.md](code-authoring.md) for the full downstream flow (worktree authoring, diff review, ship).

- 2026-07-08 — **Cut Opus spend from ambient deep-enrichment (97% of Opus usage) (`model-router.ts`, `ambient.ts`, `agent.ts`, `budget.ts` new, `types.ts`, `db/index.ts`).** `usage_events` showed the `'review'` source (deep-enrichment, `inferDeepIntent`) accounted for ~97% of all Opus requests over 7 days, run unattended by the ambient heartbeat. Empirically, 96.6% of historical `review` prompts are small enough (<12k chars) that the downgrade below actually reaches Sonnet rather than being negated by the size-bump threshold. Changes: (1) `SOURCE_TIER['review']` downgraded from `'capable'` (Opus) to `'balanced'` (Sonnet) in `model-router.ts` — large context packets (>40k chars) still bump to Opus via the existing size threshold. (2) `MAX_DEEP_PER_CYCLE` lowered from `2` to `1` in `ambient.ts`; `synthesisIntervalMs` default raised from 30 min to 60 min, including the `startSynthesisTimer` fallback that had drifted out of sync with the `DEFAULT_CONFIG` value (see config table above). (3) New `budget.ts` — `isOverDailyBudget()` compares today's total `usage_events` cost (via `dbGetUsageSummary('today')`, a new `'today'` case added to `usageSince()` in `db/index.ts`) against `AmbientConfig.dailyBudgetUsd` (falls back to `DEFAULT_CONFIG.ambient.dailyBudgetUsd`, `0` disables). Checked once per ambient cycle in `runAmbientCycle` (not once per hit — the total can't change meaningfully mid-cycle, and the check itself costs a config read + DB query) before the deep-enrichment slot is spent, falling back to lightweight `inferIntent` (Haiku) once the cap is hit for the day — never blocks the cycle. Only gates the autonomous deep-enrichment path; user-initiated chat/plan/routine calls are unaffected by design — a global per-call budget gate at the router/agent layer was considered and deferred as a larger, separate change. Separately, `agent.ts`'s `runAgentOnce` now retries once at the *same* tier — capped at a 30 s timeout regardless of the caller's `timeoutMs`, so the retry can't double a caller's worst-case latency budget — with a stricter "return only JSON" instruction before throwing the non-JSON error that triggers tier escalation; most weak-JSON failures were a formatting slip rather than a capability gap, and a same-tier retry is cheaper than climbing Haiku→Sonnet→Opus. Known trade-off left unaddressed: `inferDeepIntent`'s MCP path (`runAgentWithMcpOnce`) has no equivalent JSON-retry, so a malformed deep-enrichment response is still dropped outright — worth monitoring post-downgrade since Sonnet is somewhat more likely than Opus to produce a malformed response on this task.

- 2026-07-07 — **Polling backoff on repeated adapter failures:** `ingestion.ts`'s per-surface poll loop no longer hammers a failing adapter (expired token, rate limit, MCP server down) at full frequency forever — it now backs off geometrically (2x per consecutive failure, capped at 4x the base `pollIntervalMs`) and resets on the next success. Implementation switched from `setInterval` to a self-rescheduling `setTimeout` chain guarded by an `ingestionEpoch` counter so `stopIngestion()` can't be defeated by a poll that's already in flight. Also fixed a bug where the Jira adapter's `readConfig().mcpServers` (nonexistent field; should be `mcp_servers`) silently broke JIRA_URL-based link reconstruction.

- 2026-06-30 — **Self-target guard in intent routing pipeline (`ambient.ts`, `config.ts`).** `guardSelfTarget(obj)` added to `ambient.ts` — called after `enrichPayloadForRouting` in both `runAmbientCycle` and `routeIntent`. Converts any `slack:send`/`slack:reply` whose `proposed_action.target` (free-text from the LLM) resolves to the owner (via new `targetIsOwner()` in `config.ts`) into a `type:'flag'` with `verb:'none'`. This ensures the insight card renders non-actionably (no Send/Approve CTA) rather than proposing a useless self-send. Primary trigger: routine failures whose LLM-inferred "action" had only the owner as a plausible Slack recipient. A complementary fix in `routines.ts` now skips inference entirely for all-failed runs, so this guard acts as defense-in-depth for both routines and ambient signals.

- 2026-06-30 — **Fix non-Adobe scope leak + intent card title leak (`inference.ts`, `IntentCard.tsx`).** Two independent bugs fixed. (1) Non-Adobe items leaked through because `scope.ts:violatesScope` is fail-open when no `part_of` container edges exist (which was always the case for GitHub before the `deriveContainer` fix), and because `config.scope` was null so `violatesScope` short-circuited to allow-all anyway. Both root causes fixed upstream (see `services.md` / `knowledge-graph.md` entries). The scope gate in `ambient.ts:runAmbientCycle` and `routeIntent` is unchanged — it now actually exercises its container-comparison logic. (2) `IntentCard` now derives the card title from `verb + target` (e.g. "Comment on PR #2105 on adobecom/event-libs") instead of rendering `intent.rationale` as the heading. `rationale` is demoted to muted secondary text in the card header and full text in the "Why" detail tab. New `sanitizeRationale()` in `inference.ts` trims planning-preamble text (sentences starting with "Cannot", "I need to", "Before I", etc.) from the rationale field before it is stored, and cuts to the first sentence boundary. `sanitizeTarget()` normalises whitespace and clamps target to 160 chars. Both applied in `parseIntentObject` (lightweight path) and `parseDeepIntentObject` (deep-enrichment path). All four inference system prompts (`SYSTEM_PROMPT`, `ROUTINE_SYSTEM_PROMPT`, `SUGGEST_SYSTEM_PROMPT`, `DEEP_SYSTEM_PROMPT`) updated to describe `rationale` as a past-tense conclusion, not a description of process or intent.

- 2026-06-26 — **Proactive agentic deep-enrichment for directed-at-me items (`inference.ts`, `ambient.ts`, `triggers.ts`, `agent.ts`, renderer).** Replaces the empty-relay pattern (inferring a proposal from a DB-only context packet) with a genuine "do the legwork" pipeline for `review_requested`, `assigned`, and `mentioned` items. New pipeline: `TriggerHit.relation` (added to `triggers.ts`) identifies directed hits; `isDeepEligible()` routes them to `inferDeepIntent()` (new, in `inference.ts`) instead of `inferIntent`. `inferDeepIntent` runs a multi-turn Opus + read-only MCP agentic loop (`runClaudeWithMcp`, source `'review'`) that fetches the PR diff, changed files, existing reviews, linked tickets, or issue threads — then proposes a **concrete MCP tool call** (`actions: McpActionRef[]`) rather than a verb+payload pair. The `isReadOnlyTool` gate in `agent.ts` is generalized to recognise vendor-prefixed read tools (e.g. `jira_get_issue`, `workday_search_tasks`). Execution is fully generic: `executeActions()` (new, in `ambient.ts`) loops `intent.actions[]` and calls `callTool(server, tool, params)` directly — no verb maps, no `buildToolArgs`, no per-surface wiring. New surfaces (Workday, Miro, Figma, etc.) are auto-discoverable via `listTools()` with zero code changes. The five legacy per-surface maps (`VALID_VERBS`, `VERB_TO_TOOL`, `buildToolArgs`, `VERB_LABELS`, `enrichPayloadForRouting`) are not extended and become retirement candidates. `ambientApproveIntent` merges user-edited draft text back into `actions[0].params` for the generic path. `IntentCard` derives its CTA label from `server:tool` (e.g. "Submit review" / "Post comment") instead of the hardcoded "Send"/"Approve" binary. Per-cycle deep-enrichment cap: `MAX_DEEP_PER_CYCLE = 2`; additional eligible hits fall back to `inferIntent`. Bounded by the existing `covered`/`suppressed` dedup guards. Schema: `intents.actions TEXT NOT NULL DEFAULT '[]'`.

- 2026-06-25 — **Linear as a first-class ambient surface.** Added `'linear'` to `IntentSurface`. New `makeLinearAdapter()` in `ingestion.ts` polls `linear_get_user_issues` (text output), parses results with `parseLinearIssueText()`, and stores nodes as `linear:issue:<id>`. Added `STAGGER_OFFSETS.linear = 60_000`. Extended `VERB_TO_TOOL` with `linear: { comment: 'linear_add_comment' }`, `AUTO_EXECUTABLE` with `'linear:comment'`, `enrichPayloadForRouting` with a linear branch (injects `_issue_id`), and `buildToolArgs` with a linear branch (maps to `{ issueId, body }`). Added "Adding a new surface (three-touchpoint recipe)" guide section documenting the pattern for Notion and future surfaces.

- 2026-06-22 — **Empty-sentinel filtering.** The inference system prompt instructs the model to emit `{"type":"flag","rationale":"nothing actionable","target":"nothing","verb":"none","confidence":0}` when there is nothing to surface. A malformed copy with `confidence ≥ 0.4` bypassed the confidence floor and rendered as a confusing card. Fixed by adding `isEmptySentinel()` in `inference.ts` — drops any flag intent where `verb==='none'` and rationale is `'nothing actionable'` or target is `'nothing'`, regardless of confidence. Applied in both `inferIntent` and `inferRoutineIntents`. `QueueView.tsx` also applies a defensive render-side filter to hide any already-persisted sentinel rows without a DB migration.

- 2026-06-18 — **Fix: missing action button + challenge tier drift.** Two interacting bugs caused action intent cards to display only Dismiss / Chat / Challenge with no way to trigger the action. (1) `IntentCard.tsx` — `needsApproval` was gated on `intent.required_approval`, but the model sometimes emits `required_approval=false` even for actions the agent will never auto-execute (tier ≥ 2). The condition is now `!isObservation && intent.tier >= 2` — any action at Approve or Locked tier shows the primary button, regardless of the model hint. (2) `autonomy.ts` — `recordChallenge` had no ceiling: a single challenge from the default tier 2 would push a verb to tier 3 (Locked), where `resolveTier` treated it as absolute and `recordApproval` refused to lower it. Added `AUTO_ESCALATE_CEILING = 2` (symmetric to `AUTO_DECAY_FLOOR = 1`): challenge feedback can raise a verb to at most Approve (tier 2); reaching Locked requires explicit user opt-in in Settings. `setTier` now writes `tier_locked = true` whenever tier 3 is set explicitly, so Locks are distinguishable from drift. A one-time `schema.ts` normalization reverts all existing `tier=3 AND tier_locked=0` rows (pure drift) to tier 2; explicit Locks (`tier_locked=1`) are preserved.

- 2026-06-17 — **Button trimming — merge Suggest into Chat:** removed the standalone Suggest action from intent cards. The re-proposal capability is now an opt-in "Update the proposal" button inside the Chat panel, shown for non-terminal action intents once at least one assistant reply exists. Clicking it calls `reviseIntentFromChat` which runs `reproposeIntent` over the full `intent_chat_threads` history and applies the result in-place. The action table entry for "Suggest" is replaced by "Chat". The `intent_threads` table is deprecated (preserved for historical rows; no new writes). The `ambient.suggest` and `ambient.getIntentThread` IPC methods are replaced by `ambient.reviseFromChat`.

- 2026-06-17 — **Fix: GitHub/Jira intent actions failing with MCP `-32603` + pre-flight guard + "Chat about it" per-intent streaming chat.** Root cause: `buildToolArgs` returned the LLM payload verbatim for GitHub/Jira surfaces, but the LLM only produces `body` — never `owner`/`repo`/`issue_number`/`issue_key`. Only Slack had routing identifiers injected at intent-creation time. Three-part fix: (1) **`enrichPayloadForRouting`** — shared helper called in both `runAmbientCycle` and `routeIntent` before `dbCreateIntent`. For GitHub, parses `_owner`/`_repo`/`_issue_number` from the focus node's `url` attr (e.g. `https://github.com/adobecom/EMC/pull/188`). For Jira, extracts `_issue_key` from the `jira:issue:PROJ-123` node key. For Slack, retains existing `_channel_id`/`_thread_ts` injection. (2) **`buildToolArgs` extended** — GitHub branch maps to `{ owner, repo, issue_number, body }` / `{ owner, repo, issue_number, labels }`; Jira branch maps to `{ issue_key, comment }`; all `_`-prefixed routing fields stripped from outgoing args. (3) **Pre-flight validation guard** in `executeIntent` — after assembling args, reads the MCP tool's `inputSchema` via `getToolInputSchema()` (new export from `mcp.ts`) and fails fast with a clear human error if any `required` fields are missing, instead of letting the MCP server reject with `-32603`. (4) **"Chat about it" streaming chat** — `handleIntentChat(intentId, message)` mirrors `handlePlanMessage` (streaming via `streamChat`, broadcasts `ambient:chat-user-message` / `ambient:chat-message` chunks, persists to new `intent_chat_threads` table). The intent's `context_packet` + proposal + error are attached as `rawContext` so Claude has the same situational awareness the inference layer had. Chat is available on all intents including failed ones. `IntentCard.tsx` gains a "Chat" button and chat panel using the existing `ChatThread` component.

- 2026-06-17 — **Insight↔routine run linkage model.** When a routine run and an ambient insight both concern the same work item (e.g. PR #482), the UI now links them bidirectionally — without suppressing or auto-closing either side. The canonical entity identity is the graph-node key `surface:kind:external_id` (same as `intent.context_packet.focusNodes[].key`). After a routine collects its MCP output, the new `entity-link.ts` service (`extractCoveredEntities`) scans `rawOutput` for URL or word-boundary hits against recently-seen signals; matched items are persisted as a `CoveredEntity[]` snapshot on `routine_runs.covered_entities`. In the widget renderer, `App.tsx` builds two memoized indexes (`entityKeyToIntent`, `entityKeyToRuns`) from live state; no new IPC calls. `RoutineCard` shows a **Tracked items** section listing each covered entity with its current insight status ("Insight active" / "Handled" / "Dismissed"); `IntentCard` shows an **"Also in: <routine>"** chip. Co-resolution is emergent: approving/dismissing the insight causes the run's tracked-item status to flip live via the existing `ambient:intent-updated` push path. Resolving a run does **not** close any insight — the safety property is structural (intents are never suppressed or terminated by run lifecycle events).

- 2026-06-17 — **Fix: resolved intents re-surfaced on every synthesis heartbeat.** Root cause: `activeFocusNodeIds()` seeded the covered set only from `dbGetPendingIntents()` (status `pending`/`surfaced`). Once a user resolved an intent (challenged/executed/dismissed), its focus nodes dropped out of the covered set, so the 30-min heartbeat or any signal fingerprint change re-created a fresh intent for the same work item. Fixed: new `suppressedFocusNodeIds()` function queries terminal intents via `dbGetResolvedIntentsSince(cutoff)` and adds their focus-node ids to the covered set for a **tiered cooldown**: dismissed/challenged → 7 days, executed → 3 days, failed/expired → 1 day. **Break-through rule**: if the underlying signal's `observed_at` is newer than the intent's `resolved_at` (genuinely new activity arrived after resolution), the item is allowed through regardless of the cooldown window. Cooldowns are overridable via `AmbientConfig.resolutionCooldownMs` in `~/.mypa/config.json`. The cycle log now emits two skip counters: `C skipped (covered)` for pending-intent suppression and `D skipped (cooldown)` for resolution-cooldown suppression. No schema change.

- 2026-06-17 — **Fix: tier-3 intents surfaced silently (no notification or badge).** `handleIntent` had an early-return path for tier 3 that called `pushIntent` but exited before the `Notification` + `updateBadgeCount()` block. Because the widget is hidden by default (tray app), tier-3 action intents were never seen in real time — only discovered on relaunch or when something else (a routine) prompted opening the widget. Fixed: extracted a shared `surfaceIntent(intentId, win)` helper that covers status-update, push, notification, badge, and tray refresh; both the tier-3 branch and the tier-1/2 fall-through now call it.

- 2026-06-17 — **Durable fix: ambient always-on path was throttled into near-silence (not broken).** Root cause established by reading the full pipeline — three compounding issues, all addressed in this pass:
  - *Synthesis heartbeat first-tick deferral (primary cause):* `startSynthesisTimer` used a bare `setInterval`, so the first heartbeat — the only mechanism to re-surface persisted "waiting on me" items during quiet periods — fired 30 min after boot. In normal steady state, the continuous poller only forwards *newly-fingerprint-changed* signals, so almost all re-surfacing depends on the heartbeat. Fixed: `startSynthesisTimer` now fires an initial tick ~75 s after boot (`synthesisInitialDelayMs`, configurable), landing after all three adapter stagger offsets complete so `dbGetDirectedSignals` has populated rows.
  - *Urgency-floor over-suppression:* the system prompt explicitly instructs the model that "a clearly-real but low-stakes item should have high confidence and low urgency", so a PR waiting days for your review routinely scores urgency < 0.5 and is dropped by `inferIntent`. The routine path (`inferRoutineIntents`) bypasses covered-node suppression and feeds findings framed as fresh — so it reliably clears the floor. This asymmetry made it *look* like ambient only fires when routines run. Fixed: per-kind urgency floor in `inferIntent` — `waiting`/`staleness` triggers use `waitingUrgencyFloor` (default 0.25); `spike`/`dependency`/`time` keep the existing `urgencyFloor` (0.5).
  - *Observability gap:* the pipeline had no visibility into where it stalled — polls silently produced 0 new signals with no log, inferIntent silently dropped candidates, and the synthesis heartbeat produced no diagnostic output. Fixed: per-surface always-on poll completion log, per-cycle drop-reason aggregation, heartbeat directed-signal census (console + `diag` action-log row via `ambient.getLog()`), and structured `InferIntentResult` return from `inferIntent` with drop reasons. See **Observability** section above.
  - New config fields: `synthesisInitialDelayMs` (default 75 s) and `waitingUrgencyFloor` (default 0.25).

- 2026-06-16 — **Ambient intelligence audit — bug fixes, dead-code removal, and UI surfacing:**
  - *Bug fix — digest `decisions` always empty:* `ambientGetDigest` filtered on `status='pending'`, but `handleIntent` immediately transitions every intent to `'surfaced'` before any digest cron fires. Fixed filter to `status='surfaced' && type='action' && required_approval=true`.
  - *reproposeIntent floors:* `reproposeIntent` now applies the same `confidenceFloor`/`urgencyFloor` that `inferIntent` enforces. Sub-floor re-proposals return only the assistant's message (conversation continues); the weak proposal is not adopted. The `intent` field of `ReproposeResult` is now optional; `ambientSuggestIntent` only calls `dbReproposeIntent` when it is present.
  - *Surface orphaned backends:* `InsightsPage` now fetches and displays the full action log (`ambient.getLog`) in an **Activity** tab alongside Queue/Observations/History. A **Poll now** button in the page header calls `ambient.pollNow()` with idle/polling/done state. Both backends were previously fully implemented but unreachable from any UI.
  - *Dead code removed:* deleted `AmbientFeed.tsx` (superseded by `QueueView`); removed `evalThreshold` and `evalStaleness` alias from `triggers.ts` (neither wired into any call path); removed unused `getOwnerHandles` import from `triggers.ts`. Fixed stale section-header comment claiming threshold runs in the synthesis heartbeat.
  - *Log clarity:* fixed inverted wording in `autonomy.ts` log lines — `recordApproval` logged "trust raised" while numerically lowering the tier; `recordChallenge` logged "trust lowered" while raising it.
  - *Doc sync:* schema source-files list expanded; `AmbientFeed.tsx` removed from renderer list; GitHub `directed` logic updated in prose; Suggest floor enforcement documented; digest section descriptions made explicit; IPC table updated with `getAllIntents` and `approve` payload arg.

- 2026-06-16 — **Fix directedness, GitHub execution, and Jira/Slack ingestion parsers:** (1) `ingestion.ts:directed` — GitHub adapter now marks `assigned` and `mentioned` signals as `directed=1`, matching the Jira adapter and `dbGetDirectedSignals` whitelist; previously only `review_requested` was unconditionally directed, starving the waiting trigger of almost all signals. (2) `ambient.ts:VERB_TO_TOOL` — GitHub `comment` tool name corrected: `create_issue_comment` (non-existent) → `add_issue_comment` (`@modelcontextprotocol/server-github`). (3) `ingestion.ts:Jira parser` — realigned to `mcp-atlassian` flat snake_case response: removed `i.fields` wrapper; all field reads updated (`i.summary`, `i.url`, `i.updated`, `i.duedate`, `assignee.display_name`, `i.comments[]`/`comment.author.display_name`). JQL drops `watcher = currentUser()` (frequently invalid on Jira Server/DC). (4) `ingestion.ts:Slack parser` — `parseSlackCsv` normalizes headers to lowercase; column reads updated to `msgid`, `channel`, `username`, `userid`, `threadts` (from PascalCase Go struct fields emitted by `slack-mcp-server`).
- 2026-06-16 — **Slack polling and execution fixed (tool names + arg mapping):** `ingestion.ts` — Slack adapter poll replaced: `slack_search_public` (non-existent) → `conversations_search_messages` with Slack-native `to:<handle>` search query built from `getOwnerHandles()`; response parsing rewritten from JSON to RFC 4180 CSV (server returns gocsv format — columns `msgID/channelID/ThreadTs/text/permalink/userUser/userID/time`); added `parseCsvRow` + `parseSlackCsv` helpers. Structural relation detection (dm/mentioned/thread_reply/involved), `directed` flag, privacy-preserving `body:''`, and `normalize()` are unchanged. `ambient.ts` — `VERB_TO_TOOL.slack` updated: `slack_send_message` (non-existent) → `conversations_add_message`. Added `buildToolArgs(intent)`: for Slack, maps `payload.message → text` and `payload._channel_id/_thread_ts → channel_id/thread_ts` (conversations_add_message requires these; inference only produces `payload.message`). Slack `reply`/`send` action payloads now enriched with `_channel_id` and `_thread_ts` before `dbCreateIntent` in `runAmbientCycle` (extracted from the focus node key `slack:message:{channelId}:{ts}`). `IntentCard.tsx` — `payloadExtra` filters out `_`-prefixed routing fields so they are not shown to the user.
- 2026-06-16 — **Fix invalid Jira JQL `mention` field:** `ingestion.ts` Jira adapter — replaced the non-existent JQL clause `mention = currentUser()` (which caused the Atlassian MCP server to reject the entire query every ~5 min) with `reporter = currentUser() OR watcher = currentUser()`. The poll now queries `assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()`. Non-assigned results continue to be classified as `relation: 'mentioned'` by the existing `isAssigned` check.
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
