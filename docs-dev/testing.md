# Testing

## Scope

The suite covers the deterministic **logic layer** of the main process — pure functions
and service decision-logic (autonomy trust tiers, trigger evaluators, intent parsing,
config clauses, embeddings math, graph rendering) — with the database and `electron`
mocked. It deliberately does **not** cover orchestration glue that mostly forwards calls
to external processes: `cron.ts`, `oauth.ts`, `worktree.ts`, `routines.ts`, `claude.ts`,
`ingestion.ts`, `mcp.ts`, `authoring.ts`, and the bulk of `ambient.ts`'s wiring. There is
no renderer/UI test layer.

Run it:

```bash
npm test            # run once (CI mode)
npm run test:watch  # watch mode
npm run test:coverage
```

---

## Why the DB and `electron` are mocked, not real

Two obstacles rule out testing against the real database or a real Electron runtime:

1. **`electron` is imported at the top of many service files** (`app.getPath`,
   `Notification`, `safeStorage`, `shell`) purely for definitions that are only
   exercised at runtime — but the *import itself* throws outside an Electron process.
   `test/setup.ts` registers a single global `vi.mock('electron', ...)` (via Vitest's
   `setupFiles`) that stubs these out for every test file.

2. **`better-sqlite3` is a native module compiled for Electron's ABI**, not the system
   Node that runs Vitest (see `package.json`'s `postinstall: electron-rebuild -f -w
   better-sqlite3`). Loading the real compiled binary under plain Node throws a
   `NODE_MODULE_VERSION` mismatch. Rather than juggling two native builds, every test
   that exercises DB-backed logic mocks `@main/db/index` wholesale (`vi.mock('@main/db/index',
   () => ({ dbGetPolicy: vi.fn(), ... }))`) and asserts on the *branching logic* —
   trust-tier math, trigger firing conditions — using controlled mock return values. The
   real schema (`src/main/db/schema.ts`) and query layer are never exercised by this
   suite; `initSchema()` itself has no Electron dependency and would be the natural
   seam for a future real-DB integration layer (`new Database(':memory:')` + `initSchema(db)`),
   but that's out of scope for the current logic suite.

Because of (2), no test in this suite ever calls `initDb()` or otherwise triggers the
lazy `require('better-sqlite3')` inside it — so the ABI mismatch never actually surfaces
here, and the suite runs on whatever Node runs `npm test`.

---

## Layout

Tests live in a top-level `test/` directory mirroring `src/`, kept separate from the
three app tsconfigs (`tsconfig.node.json`, `tsconfig.preload.json`, `tsconfig.web.json`)
so test files are never bundled by `electron-vite` and never affect `npm run typecheck`.

```
test/
  setup.ts                          — global electron mock (Vitest setupFiles)
  shared/
    scope-surfaces.test.ts
    mcp-catalog.test.ts
  main/
    db/
      computeFingerprint.test.ts
    services/
      model-router.test.ts
      autonomy.test.ts
      triggers.test.ts
      inference.test.ts
      config.test.ts
      embeddings.test.ts
      memory-graph.test.ts
      ambient.test.ts
```

`vitest.config.ts` declares the same `@shared` alias as `electron.vite.config.ts`, plus
a test-only `@main` alias (→ `src/main`) — main-process modules have no alias in
production since they only ever import each other by relative path.

`tsconfig.vitest.json` gives the `test/` tree editor type support (`vitest/globals`,
the `@shared`/`@main` paths); it is not part of `npm run typecheck`.

---

## Mocking pattern

Per-file `vi.mock(...)` calls replace only the modules a given source file imports,
scoped to what that file actually destructures — not a blanket auto-mock. Two shapes
recur:

**Pure functions with no runtime dependency** (`model-router.ts`, `scope-surfaces.ts`) —
imported and called directly, no mocking beyond the global `electron` stub.

**DB/service-backed decision logic** — the dependency module is replaced wholesale, e.g.:

```ts
vi.mock('@main/db/index', () => ({
  dbGetPolicy: vi.fn(),
  dbUpsertPolicy: vi.fn(),
  // ...only the names the source file actually imports
}))

const { resolveTier } = await import('@main/services/autonomy')
const db = await import('@main/db/index')

it('floors irreversible actions at tier 2 regardless of policy', () => {
  vi.mocked(db.dbGetPolicy).mockReturnValue(policy({ tier: 0 }))
  expect(resolveTier(intent({ reversibility: 'irreversible' }))).toBe(2)
})
```

`vi.mock` is resolved by the mocked module's absolute file path, not by the specifier
string used at each call site — mocking `@main/services/config` in a test also
intercepts every other file's `import ... from './config'` (or `'../config'`), since
they resolve to the same file.

Where a heavily-imported module (`ambient.ts`, pulling in ~14 sibling services) is
only being tested for a couple of pure helper functions, every sibling import is
stubbed with a minimal `vi.fn()` object — mechanical, but it keeps the module loadable
without dragging in DB/network/process code that has nothing to do with the functions
under test.

## Adding a test

1. Find (or create) the mirrored path under `test/`.
2. If the source file imports `electron` only — no extra mocking needed, the global
   setup covers it.
3. If it imports `@main/db/index` or a sibling service, `vi.mock` only the named
   exports that file actually imports, controlling return values per test with
   `vi.mocked(fn).mockReturnValue(...)`.
4. Prefer testing pure/branching logic directly over asserting on internal DB calls.

## Changelog

- 2026-07-23 — initial test suite: Vitest, `electron`/`@main/db/index` mocking strategy, logic-only scope (see [services.md](services.md) for the module list this suite covers).
