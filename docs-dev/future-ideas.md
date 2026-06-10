# Future Ideas

Ideas that have been deliberately deferred. Each entry explains what it is, why it was parked, and what would need to be true before it becomes worth picking up.

---

## Executable plan actions ("Do it" button on plan items)

**What:** Plan items would carry a populated `actions: McpActionRef[]` field derived from the AI-generated draft. A "Do it" button on `PlanItemCard` would execute the action through the same verb→tool allowlist and autonomy guardrails as the ambient intent pipeline.

**Three parts:**
1. `generatePlanDraft` in `claude.ts` currently hardcodes `actions: []`. Extend the prompt to optionally emit an `McpActionRef[]` when the natural-language task maps to a known verb (`github:comment`, `jira:comment`, `slack:reply`, etc.). Needs schema validation — a malformed `params` object silently turns into a wrong API call.
2. New `plan.runAction(id)` IPC handler in `ipc-handlers.ts`: reads `item.actions[0]`, validates the verb is in `VERB_TO_TOOL`, calls the MCP tool, updates item status to `'done'`, broadcasts `badge:updated`.
3. `PlanItemCard.tsx`: "Do it" button (lucide `Zap` icon) visible only when `item.actions.length > 0 && item.status === 'pending'`.

**Why parked:** The prompt engineering is the hard part. The ambient pipeline works because signals are structured (GitHub/Jira/Slack payloads have known shapes). Plan items come from freeform user text — reliably extracting a correct `tool + params` from "remind Alex about the deploy window" is a higher bar. Shipping a button that occasionally calls the wrong tool with the wrong params is worse than not having it.

**What needs to be true first:**
- A few real usage examples to observe what intents users actually type.
- A validation step that rejects generated actions unless confidence in the param extraction is high (e.g. the model must name the specific issue number / PR number / channel, not infer it).
- Plan actions must always require approval (no tier-0 path), at least initially.

**Files to touch:** `src/main/services/plan.ts`, `src/main/services/claude.ts`, `src/main/ipc-handlers.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/src/widget/components/PlanItemCard.tsx`, `docs-dev/ipc.md`, `docs-dev/services.md`.
