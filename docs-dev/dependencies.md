# Dependencies — Transitive npm Deprecation Warnings

`npm install` prints a handful of `npm warn deprecated` lines. All of them are **transitive** — pulled in by electron-builder, electron, better-sqlite3, or electron-updater — and none of them can be safely resolved today. They do not affect the shipped app; they are dev/build-tooling packages that never reach the production bundle.

This document records the investigation so it doesn't have to be repeated.

## The six warnings

| Deprecated package | Deprecation reason | Immediate parent chain | Why it cannot be fixed safely |
|---|---|---|---|
| `glob@7.2.3` | Old, unfixed security vulns in v7 | `@electron/asar@3` ← `app-builder-lib` ← `electron-builder` | `@electron/asar@3` does `util.promisify(glob.glob)` — glob v9+ removed the callback API, so a forced override breaks `npm run dist` |
| `inflight@1.0.6` | Memory leak, unmaintained | `glob@7` (above) | Disappears only when `glob@7` goes; blocked on the same upstream fix |
| `rimraf@2.6.3` | Pre-v4 unsupported | `temp` ← `electron-winstaller` ← `electron-builder-squirrel-windows` (hard peer of `app-builder-lib`) ← `electron-builder` | `temp@0.9.4` calls `rimraf.sync()` and `rimraf(path, opts, callback)` — both removed in rimraf v4+; squirrel-windows installs as a hard peer even though our `win.target` is `nsis` |
| `lodash.isequal@4.5.0` | Use `node:util.isDeepStrictEqual` | `electron-updater@6.8.9` | The latest `electron-updater` release (6.8.9) still depends on it; upstream has not released a fix |
| `prebuild-install@7.1.3` | No longer maintained | `better-sqlite3@11` | `better-sqlite3@12` still depends on the same version; not removable without waiting for an upstream release |
| `boolean@3.2.0` | Package unsupported | `global-agent@3` ← `@electron/get` / `onnxruntime-node` | The next major is `global-agent@4`, which is ESM-only; forcing it via `overrides` breaks the CommonJS `require()` path used by both callers |

## Why overrides don't work

The obvious fix — adding entries to `package.json`'s `overrides` field — was tested and **breaks `npm run dist`**:

- `glob@9+` removed the promisify-compatible callback signature; `@electron/asar@3` will crash at package time.
- `rimraf@4+` removed `sync`/callback forms; `temp@0.9.4` will crash when electron-winstaller cleans up temp files.

The fix must come from upstream packages releasing new majors.

## Upstream tracking

When these are upgraded in their respective projects, the warnings will clear naturally:

| Warning source | Upstream fix needed |
|---|---|
| `glob`, `inflight`, `rimraf` | `electron-builder` v27+ (or `@electron/asar@4+`) |
| `lodash.isequal` | `electron-updater` replacing lodash with `node:util` |
| `prebuild-install` | `better-sqlite3` migrating to an alternative prebuilt strategy |
| `boolean` | `global-agent@4` adopting a CJS-compatible release |

## Changelog

- 2026-06-16 — initial investigation documented; all six warnings traced and overrides confirmed to break packaging
