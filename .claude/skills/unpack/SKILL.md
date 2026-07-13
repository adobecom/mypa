---
name: unpack
description: Rebuilds mypa from the current working tree and installs it into /Applications, replacing the existing app. macOS only. Use when the user asks to "rebuild and pack/install the app", "unpack a new build", "reinstall mypa", "put the new build in Applications", or wants to try local changes as the actual installed app rather than via `npm run dev`.
---

# Unpack: rebuild and install mypa locally (macOS only)

Rebuilds mypa from whatever is currently checked out and replaces `/Applications/mypa.app` with the fresh build — the fastest way to try real code changes as the actual packaged app, without cutting a signed installer.

**macOS only.** Run `uname -s` first; if it's not `Darwin`, stop and tell the user this skill is macOS-only. (The project also builds AppImage/deb for Linux and nsis for Windows via `npm run dist`, but this skill doesn't handle those.)

## Steps

1. **Confirm platform** — `uname -s` must be `Darwin`.

2. **Check working tree state** — `git status --short`. Not a blocker (this builds whatever is currently checked out, including uncommitted changes), but mention to the user what's uncommitted, if anything, so they know exactly what they're about to install.

3. **Build** — `npm run build` (electron-vite build: compiles main/preload/renderer). Must finish cleanly. If it fails, stop and report the error rather than packing a stale or broken build.

4. **Pack** — `npm run pack` (`electron-builder --dir`). Produces an unpacked `.app` under `dist/<arch-dir>/mypa.app`, where `<arch-dir>` is `mac-arm64` on Apple Silicon or `mac` on Intel. Discover the actual directory with `ls dist | grep '^mac'` rather than hardcoding the arch — don't assume which Mac this is running on.

5. **Check if mypa is currently running** — `pgrep -fl "mypa.app"`. If it is, tell the user to quit it from the tray before relaunching afterward. Copying over a running app bundle is safe on macOS (the running process holds its old inode), but a stale running instance won't reflect the new build until relaunched.

6. **Replace the installed app.** This is a real, hard-to-reverse action outside the repo (overwrites `/Applications/mypa.app`). The user invoking this skill is explicit authorization to do exactly that — proceed without a separate confirmation prompt, but state plainly in your response that you're replacing it:
   ```
   rm -rf /Applications/mypa.app
   cp -R "dist/<arch-dir>/mypa.app" /Applications/mypa.app
   ```

7. **Clear the quarantine flag** — the build is unsigned (`identity: null` in `package.json`'s `build.mac` config), so Gatekeeper blocks the first launch otherwise:
   ```
   xattr -dr com.apple.quarantine /Applications/mypa.app
   ```

8. **Confirm** — `ls -la /Applications | grep -i mypa` and report success, reminding the user to (re)launch it from Applications or Spotlight.

## Notes

- This is `npm run pack`, not `npm run dist` — no dmg/zip, no code signing, just the fastest path from source to a runnable local `.app`. If the user wants an actual distributable installer, use `npm run dist` instead.
- `electron-builder`'s packaging step rebuilds native dependencies (`better-sqlite3`) for the correct Electron ABI automatically — no separate `npm run postinstall` needed unless a native dependency itself changed.
- Never touches `~/.mypa/config.json` or `~/.mypa/data.db` — only the app bundle in `/Applications` is replaced, so the user's config and data survive the reinstall.
- Auto-update can't be exercised on a build installed this way: `--dir` mode never writes `Contents/Resources/app-update.yml` (electron-builder only writes it when building the mac zip/dmg target). "Check for Updates" on an unpack-installed app shows a friendly "not installed from a signed release" toast rather than checking anything — that's expected, not a bug.
