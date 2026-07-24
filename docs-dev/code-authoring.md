# Code Authoring

First slice of mypa's "investigate → fix → ship" vision: when a ticket or PR is directed at the user and its container maps to a repo they've linked, mypa can attempt a real code fix in an isolated git worktree, then present the diff for one-tap shipping (push + open PR + comment the ticket).

This closes a deliberate architectural boundary. Every other AI call in the app (see [claude-integration.md](claude-integration.md)) runs with `tools: []` — no Bash, Edit, Read, or Write — and can at most propose an MCP tool call for the user to approve (comment, label, PR review, Slack message). `runAuthoringAgent` in `agent.ts` is the sole exception: it grants real file/shell tools, but only inside a disposable worktree with a narrow `canUseTool` gate, and only after the user has explicitly approved starting the attempt.

## Why this design

- **Local git worktree, not a container or cloud sandbox.** The user already has the repo checked out locally; a worktree is a cheap, native git primitive that gives an isolated working directory + branch without touching the real checkout, and without adding Docker/cloud infrastructure to a local-first app.
- **Approve-to-start, not fully background.** The first slice surfaces "Attempt a fix? [Start]" rather than silently authoring on every directed trigger — safer default, and it reuses the existing trust-tier machinery (`autonomy.ts`) so a repo can graduate toward less friction the same way any other action type does (5 consecutive approvals → tier down; tier 0 still requires explicit Settings opt-in).
- **`ambient.ts` untouched.** `authoring.ts` imports `ambientDismissIntent` from `ambient.ts` (one-way), but `ambient.ts` does not import `authoring.ts` and its existing `executeIntent`/`executeActions` paths are unmodified. `author_fix` intents are surfaced exactly like any other tier-2 action intent; the "Start"/"Ship it" actions are separate IPC calls (`ambient.startAuthoring`/`shipWorkProduct`), not routed through the generic approve/execute pipeline.

## End-to-end flow

```
1. Ticket/PR directed at the user (review_requested / assigned / mentioned)
2. inferDeepIntent (inference.ts) resolves the item's container to a linked,
   authoring-enabled RepoLink (repos.ts resolveRepoForNode)
     └── tryProposeAuthorFix: read-only decision call — "could a coding agent
         attempt this?" If yes: emits an author_fix-verb action intent with a
         self-contained task_description. If no: falls through to the normal
         comment/review proposal.
3. Intent surfaces in the widget (WorkProductCard, tier 2 = approve-to-start)
4. User taps "Start" → ambient.startAuthoring(intentId)
     └── authoring.ts startAuthoring:
           - resolve RepoLink, createWorktree (worktree.ts)
           - runAuthoringAgent (agent.ts) — Bash/Edit/Read/Write/Grep/Glob,
             cwd pinned to the worktree, network/push/clone/remote blocked
           - captureDiff → work_products row (status: ready)
5. WorkProductCard shows the diff + summary; user taps "Ship it"
6. ambient.shipWorkProduct(intentId)
     └── authoring.ts shipWorkProduct:
           - pre-flight validate required fields for every planned step
           - commitAndPush (worktree.ts)
           - callTool('github', 'create_pull_request', ...)
           - comment on the originating ticket (jira_add_comment / add_issue_comment)
           - intent → executed; work product → shipped
```

## Repo links

A `RepoLink` (`src/shared/types.ts`) maps an external container to a local checkout:

```ts
interface RepoLink {
  id: string
  localPath: string          // absolute path to an existing git checkout
  githubRepo?: string        // "owner/name", derived from `git remote get-url origin`
  jiraProjectKeys: string[]  // e.g. ["PROJ"] — auto-derived from git history, not user-entered
  defaultBaseBranch: string  // derived from origin/HEAD
  authoringEnabled: boolean  // opt-in per repo; defaults to false for discovered repos
  source?: 'discovered' | 'manual'
  lastSeenAt?: string        // ISO timestamp of the most recent scan that found this repo
  created_at: string
}
```

Stored in `AppConfig.repos` (config.json), not the DB — registration is a config mutation, mirroring how MCP servers are configured. `RepoLink`s are **auto-discovered**, not hand-registered: the user configures one or more parent folders (`AppConfig.codeRoots`) in Settings, and `repos.ts` `rescanRepos()` walks each for git checkouts, deriving `githubRepo`/`defaultBaseBranch`/`jiraProjectKeys` and filtering to the configured GitHub-org scope. `jiraProjectKeys` is inferred, not typed in by the user — `deriveJiraProjectKeys` scans recent commit subjects/bodies and local branch names for `KEY-123`-style references and keeps any key seen more than once, since a one-off stray mention shouldn't route a whole repo. New discoveries default `authoringEnabled: false` — authoring (mypa opening a real PR against the checkout) is an explicit per-repo opt-in, toggled in the Settings "Repos" section (`ReposSection` in `Settings.tsx`). mypa **never clones a repo itself** — the scanner only reads (`.git` presence, `git remote get-url origin`, `git symbolic-ref .../HEAD`, `git log`, `git for-each-ref`). A `source: 'manual'` link may still exist from before auto-discovery shipped; the scanner never edits or removes those.

`resolveRepoForSignal(signal)` / `resolveRepoForNode(key, url?)` match a signal or graph-node key to a `RepoLink` with `authoringEnabled`, reusing the same owner/repo and Jira-project-key parsing as `deriveContainer` in `memory-graph.ts`.

## Isolated worktrees

`worktree.ts` creates one worktree per attempt at `~/.mypa/worktrees/<repo>/<slug>/` on a fresh branch `mypa/<slug>`, from `origin/<defaultBaseBranch>` (fetched fresh each time). The user's real checkout at `repoLink.localPath` is only ever read (`git fetch`) — never checked out to, so its working tree and index are untouched throughout the whole flow.

- `captureDiff(worktreePath)` — `git add -A` (safe; the worktree is disposable) then reads `--stat`/`--name-only`/full patch from the staged diff. Does not commit.
- `commitAndPush(worktreePath, branch, message)` — commits and pushes, called only from `shipWorkProduct` once the user approves.
- `pruneWorktree(repoLocalPath, worktreePath, branch, abandon)` — removes the worktree (and the local branch, if abandoning) on discard.

## The authoring agent — `runAuthoringAgent`

See [claude-integration.md](claude-integration.md#runauthoringagent--the-one-call-site-with-real-fileshell-tools) for the full write-up. In short: the only place in the codebase Claude gets `Bash`/`Edit`/`Read`/`Write`/`Grep`/`Glob`, contained by a worktree-pinned `cwd` and a `canUseTool` gate that confines `Edit`/`Write`/`Read`/`Grep`/`Glob` calls to the worktree by path and blocks the clearest `Bash` escape hatches (git push/fetch/pull/clone/remote/submodule/ls-remote, network tools, `rm -rf` at an absolute or home path). Model tier is `'authoring'` → Opus unconditionally (user-initiated, not unattended). A 15-minute wall-clock deadline bounds the whole run. The agent does not commit — `authoring.ts` does that at ship time.

**Bash is not path-confined and the denylist is honestly best-effort, not a sandbox** — see the block comment above `BASH_DENY_RE` in `agent.ts` for the exact reasoning, including a known residual risk: the agent's environment carries a live Anthropic credential (the SDK needs it to make its own API calls), and a sufficiently malicious, prompt-injected task could attempt to exfiltrate it via a technique the denylist doesn't cover. Closing this fully needs either an SDK-level way to withhold that credential from spawned Bash children specifically, or a real OS-level network sandbox — neither exists yet; this is a tracked follow-up, not something this denylist claims to solve.

**Ship-time routing is derived from the trusted triggering signal, never from the model's own JSON.** `deriveTrustedTicketRouting` in `inference.ts` — mirroring the same trust boundary `enrichPayloadForRouting` establishes in `ambient.ts` — parses the `_issue_key`/`_owner`/`_repo`/`_issue_number` fields that `shipWorkProduct` comments on directly from the graph node that triggered the run (its `key`/`url`), not from anything the author-fix decision model claims. There is deliberately no model-chosen Slack-notification step: unlike a ticket comment, which has a trusted anchor (the item that triggered the run), "which channel to notify" has no equivalent trusted source, and accepting the model's own guess would let content it read from an external ticket/PR pick a real notification's destination.

## Work products

A `WorkProduct` (`work_products` table, see [database.md](database.md)) is the durable record of one attempt — one per intent (`UNIQUE(intent_id)`):

| Field | Notes |
|---|---|
| `status` | `drafting → ready → shipping → shipped`, or `failed`/`abandoned` |
| `summary`, `diff_stat`, `files_changed`, `diff` | Captured once authoring finishes |
| `pr_url` | Set once `create_pull_request` succeeds |

`authoring.ts` owns the full lifecycle: `startAuthoring`, `shipWorkProduct`, `discardWorkProduct`, `getWorkProductForIntent`. See [services.md](services.md#authoringts--code-authoring-lifecycle) for the exact contract of each.

### Ship failures are partial, not silent

`shipWorkProduct` validates every planned step's required fields before making any external call. Once underway, a failure after the PR was opened is recorded with what actually completed (e.g. `"PR opened (<url>) but a later step failed: ..."`) rather than lost — the work product's `error` and `pr_url` fields together tell the truth about how far shipping got.

## UI

`WorkProductCard.tsx` (widget) renders in place of `IntentCard` for `author_fix`-verb intents (`QueueView.renderIntentCard`). It polls `ambient.getWorkProduct(intentId)` on mount and subscribes to the `ambient:work-product-updated` push event (filtered by `intent_id`) for live updates. Buttons: **Start** (no work product yet), **Ship it** / **Discard** (status `ready`), **Discard** (status `failed`). A collapsible file list and raw-diff `<pre>` block let the user review the change before shipping.

## What's deliberately out of scope for this slice

- No background graduation logic beyond what the existing trust-tier machinery already provides for free (tier 2 default; `repo:author_fix` earns trust like any other action type).
- No Figma / related-ticket graph traversal in the authoring prompt yet (see the roadmap below).
- No retry-in-place for a failed ship — the branch/commit already exists; the user must inspect and finish manually, or discard and start over.
- No diff editing in the UI — the diff is authored, reviewed, and shipped as-is (or discarded).
- No Slack (or any other) ship-time notification — deliberately cut after security review found there was no trusted way to validate a model-chosen notification destination (see "Ship-time routing" above). Revisit only with a trusted anchor for the destination (e.g. a channel the user explicitly configures per repo in Settings, not one the model infers from ticket content).

## Roadmap beyond this slice

- Full background graduation UX (auto-start without a tap, once a repo has earned enough trust) — the tier machinery already supports this; only the "always ask on tier ≥ 2" default in the widget needs a per-repo override surfaced in Settings.
- Add Figma to `mcp-catalog.ts` and feed design context into the author-fix decision prompt when a ticket links a Figma URL.
- Walk `blocked_by`/`relates_to` graph edges in the decision/authoring prompts so a fix considers related tickets, not just the one that triggered it.

## Changelog

- 2026-07-23 — **Repo links are auto-discovered from user-chosen code roots instead of added by hand.** See [services.md](services.md#changelog) for the full scan/reconciliation writeup. Summary here: `RepoLink` gains `source`/`lastSeenAt`; `authoringEnabled` now defaults to `false` for every newly discovered repo (was `true` on manual add) — a repo only becomes an authoring target once the user flips its toggle in Settings.
- 2026-07-09 — **Security review pass before first release: closed a model-controlled action-redirection gap and hardened the authoring sandbox.** `inference.ts` no longer lets the author-fix decision model choose the ticket/Slack destination for the ship-time comment — new `deriveTrustedTicketRouting` derives it from the trusted triggering graph node instead (mirroring `enrichPayloadForRouting` in `ambient.ts`); the Slack-notification step and `reviewers` field were removed entirely rather than shipped with an unvalidated model-chosen destination. `agent.ts`'s `canUseTool` now also confines `Grep`/`Glob` to the worktree by path (previously unconditionally allowed — a de facto arbitrary-file-read); `BASH_DENY_RE` expanded to cover `git ls-remote` and common network/DNS tools with no legitimate use in a build/test workflow. See "The authoring agent" above for the residual, honestly-documented limits (Bash is not fully path-confined; a live Anthropic credential is present in the agent's environment).
- 2026-07-09 — Initial slice: `RepoLink`/`WorkProduct` types, `repos.ts`, `worktree.ts`, `authoring.ts`, `runAuthoringAgent` in `agent.ts`, `work_products` table, `author_fix` proposal path in `inferDeepIntent`, `repos`/`ambient.*` IPC, `WorkProductCard.tsx`, Settings `ReposSection`.
