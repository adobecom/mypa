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
| `spike` | A node's weight increased sharply in the last poll window (sudden activity) |
| `staleness` | A node hasn't been updated in a configurable threshold (item going stale) |
| `dependency` | A dependency or blocker edge connects to a node with recent activity |
| `threshold` | A numeric metric (PR age, issue count, etc.) crosses a configured limit |
| `time` | A scheduled digest slot (morning / midday / eod) is due |
| `directed` | A single inbound signal from a non-owner actor looks like a question or request |

### Directed-at-me trigger

The `directed` trigger is the only kind that fires on a **single signal** rather than a volume pattern. It addresses the gap where a single Jira comment ("can we move this to next sprint?") would never trip a spike, so the agent would never propose a response.

**Logic** (`evalDirectedAtMe` in `triggers.ts`):
1. For each new signal, skip it if `signal.actor` matches any of the user's configured handles (own activity).
2. Concatenate `signal.title + signal.body` and test against a fixed set of regex patterns: `?`, `can we/you/i`, `should we`, `please`, `lgtm`, `review`, `approve`, `defer`, `move to`, `next sprint/release/milestone`, `what do you think`, `is it ok/okay`.
3. On a match, resolve the signal to its memory-graph node and return a `TriggerHit` with `kind: 'directed'`.
4. Returns at most one hit per poll cycle to avoid flooding inference.

**Autonomy path**: once the inference pipeline generates a `jira:comment` or `github:comment` intent from a `directed` hit and the user approves it 5 consecutive times, the `surface:verb` policy drops to Tier 1 (notify-only). With an explicit Tier 0 opt-in, subsequent matching comments are sent automatically — enabling the "reply on my behalf" use case.

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
- `confidence` — 0–1 score from inference; filtered against `confidenceFloor`.
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
| `getDigest(slot?)` | Latest digest for a slot |
| `getTrayState()` | Current tray state |
| `getPolicy()` | All autonomy policies |
| `setTier(type, tier, locked?)` | Manual tier override |
| `resetTrust()` | Reset all policies |
| `pollNow()` | Trigger immediate poll |
| `getLog(limit?)` | Recent action log |

## Changelog

- 2026-06-09 — **macOS Dock badge:** `windows.updateBadgeCount()` now calls `app.setBadgeCount(n)` so the Dock icon shows a numeric red badge equal to `pendingRuns + pendingItems + pendingIntents`. Distinct from the tray red dot (which requires a tier ≥ 2 approval-required action intent): Dock = total pending count, tray = explicit user action required. Badge is set on startup and updated on every count-changing event.
- 2026-06-09 — **routines as action generators (Phase B):** `executeRoutine` now runs `inferRoutineIntents(name, rawOutput)` after the digest step, producing up to 3 `IntentObject`s from one Claude call. Each result is routed through `ambient.routeIntent()` with `trigger_kind:'routine'` so routine-generated action candidates appear in the widget queue alongside ambient intents, use the same tier/trust engine, and appear in the main-window Activity page. `TriggerKind` extended with `'routine'`. The digest card and chat thread are preserved.
- 2026-06-09 — **action-centric redesign (Phase A):** inference `SYSTEM_PROMPT` now strongly prefers `type:"action"` over `suggestion`/`flag`; instructs the model to draft the full artifact text into `payload.body`/`message` so the user gets an editable draft rather than a vague suggestion. `suggestion` type is no longer emitted (kept in `VALID_TYPES` for backwards compat with stored intents). Triage split: only `action`-type intents fire OS notifications, update the badge, and drive tray state; informational intents (`flag`/`digest`) are still stored and pushed via `broadcast` to both windows but do not interrupt the user. `pushIntent` now uses `broadcast()` (all windows) instead of widget-only send, so the new main-window Activity page receives all intents. `ambientApproveIntent` accepts an optional `payload` arg and persists the user-edited draft via `dbUpdateIntentPayload` before executing.
- 2026-06-08 — added `directed` trigger kind (`evalDirectedAtMe`); fires on single inbound signals from non-owner actors containing question/request language; documented autonomy path for "reply on my behalf" PM use case
- 2026-06-07 — `executeIntent` now calls `broadcast('ambient:action-executed', intent)` after a tier-0 intent succeeds, so the main window can surface a toast; `ambient.ts` imports `broadcast` from `../windows`
- 2026-06-07 — `inferIntent` now appends the owner-identity clause to its system prompt (via `buildOwnerClause`); `renderPacketForPrompt` tags owner person-nodes as `you (handle)` in relationship and focus lines when `AppConfig.owner.handles` is configured
- 2026-06-07 — trust two-level tier resolution: `resolveTier` falls back to intent-type policy (Settings controls) when no per-surface:verb policy exists; streak is reset on tier promotion to ensure each step costs the full threshold; Settings UI now does exact `action_type` match instead of fragile `startsWith`
- 2026-06-06 — initial documentation
