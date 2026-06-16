import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import { join } from 'path'

/**
 * Augments process.env.PATH so that packaged Electron apps launched from
 * Finder/Dock can find CLIs (claude, npx, etc.) that live in the user's
 * shell PATH.  On macOS, GUI apps only inherit the bare system PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) — not the rich PATH set up by the
 * user's shell profile.
 *
 * Strategy:
 *  1. Probe the user's login shell (login-only, not interactive) to capture
 *     its real PATH.  Login-only (-lc) sources .zprofile/.zshenv where
 *     Homebrew, mise, pyenv etc. write their PATH lines, without loading
 *     interactive plugins (.zshrc / oh-my-zsh) that can block for seconds.
 *  2. Union it with a static list of well-known bin dirs so the app still
 *     works when the shell probe fails.
 *
 * Call once, before any child-process spawning, at the top of main().
 */
/**
 * Enumerate all ~/.nvm/versions/node/<ver>/bin dirs that exist on disk,
 * newest node version first.  Returns an empty array when nvm is not present.
 */
function nvmBinDirs(home: string): string[] {
  if (!home) return []
  const versionsDir = join(home, '.nvm', 'versions', 'node')
  try {
    return readdirSync(versionsDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(versionsDir, v, 'bin'))
  } catch {
    return []
  }
}

export function fixPath(): void {
  if (process.platform === 'win32') return   // Windows inherits PATH correctly from the shell

  // ── 1. Try to get PATH from the user's login shell ────────────────────────
  let shellPath = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const sentinel = '__MYPA_PATH__:'
    // Use execFileSync (not execSync) so the shell binary path is not
    // re-interpreted by /bin/sh — avoids injection if SHELL contains spaces.
    // -lc = login + command: sources .zprofile/.zshenv (where PATH is set)
    // without loading interactive hooks, keeping probe time under ~100 ms.
    const raw = execFileSync(shell, ['-lc', `echo -n "${sentinel}$PATH"`], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    // lastIndexOf guards against any banner text a login shell might print.
    const idx = raw.lastIndexOf(sentinel)
    if (idx !== -1) shellPath = raw.slice(idx + sentinel.length).trim()
  } catch {
    // Shell probe failed — fall through to the static fallback only
  }

  // ── 2. Build the merged PATH ───────────────────────────────────────────────
  const home = process.env.HOME || ''

  const staticDirs = [
    // Homebrew (Apple Silicon & Intel)
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    // Official Claude Code installer
    `${home}/.claude/local`,
    // npm global (default prefix ~/.npm-global)
    `${home}/.npm-global/bin`,
    // User-local installs (mise, fnm, pip --user, etc.)
    `${home}/.local/bin`,
    // Other package managers
    `${home}/.bun/bin`,
    `${home}/.volta/bin`,
    // nvm: every installed node-version bin dir (newest first)
    ...nvmBinDirs(home),
    // System defaults
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]

  // Union: shell path first (highest priority), then static dirs, deduplicated
  const seen = new Set<string>()
  const merged: string[] = []
  for (const dir of [
    ...(shellPath ? shellPath.split(':') : []),
    ...(process.env.PATH ? process.env.PATH.split(':') : []),
    ...staticDirs
  ]) {
    const d = dir.trim()
    if (d && !seen.has(d)) {
      seen.add(d)
      merged.push(d)
    }
  }

  process.env.PATH = merged.join(':')
}
