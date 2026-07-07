/**
 * Minimal append-only file logger for the main process.
 *
 * Writes structured lines to ~/.mypa/mypa.log so errors survive the dev
 * terminal session. All writes also mirror to console so dev-mode behavior
 * is unchanged. A 1 MB size cap triggers a half-truncation on the next write
 * (keeps the newest half) so the file never grows unbounded.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LOG_DIR = join(homedir(), '.mypa')
const LOG_PATH = join(LOG_DIR, 'mypa.log')
const MAX_BYTES = 1_024 * 1_024 // 1 MB

function ensureDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

function rotateIfNeeded(): void {
  try {
    const { size } = statSync(LOG_PATH)
    if (size < MAX_BYTES) return
    // Keep the newest half: drop everything before the midpoint line boundary.
    const raw = readFileSync(LOG_PATH, 'utf8')
    const mid = Math.floor(raw.length / 2)
    const cutAt = raw.indexOf('\n', mid)
    const kept = cutAt >= 0 ? raw.slice(cutAt + 1) : raw.slice(mid)
    writeFileSync(LOG_PATH, `[logger] rotated at ${new Date().toISOString()}\n` + kept, 'utf8')
  } catch {
    // Rotation is best-effort — never let it break a log call.
  }
}

// Common secret shapes that might appear in an MCP tool's error/response text
// (e.g. a misconfigured server echoing its own auth header back). Redacted
// before anything is written to disk in plaintext.
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g, // GitHub PAT / OAuth / user-to-server / refresh tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bsk-[A-Za-z0-9_-]{10,}/g // generic API-key-shaped secrets (OpenAI/Anthropic-style)
]

function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]')
  }
  return out
}

function write(line: string): void {
  try {
    ensureDir()
    rotateIfNeeded()
    appendFileSync(LOG_PATH, line + '\n', 'utf8')
  } catch {
    // File I/O is best-effort — never let it throw into callers.
  }
}

/**
 * Log an informational message.
 * Also printed to console.log so dev-terminal output is unchanged (redaction aside).
 */
export function logInfo(scope: string, msg: string): void {
  const line = redact(`${new Date().toISOString()} [${scope}] ${msg}`)
  console.log(line)
  write(line)
}

/**
 * Log an error with an optional Error object.
 * Also printed to console.error so dev-terminal output is unchanged (redaction aside).
 */
export function logError(scope: string, msg: string, err?: unknown): void {
  const detail = err instanceof Error
    ? `: ${err.message}${err.stack ? ' | ' + err.stack.replace(/\n/g, '\\n') : ''}`
    : err !== undefined
    ? `: ${String(err)}`
    : ''
  const line = redact(`${new Date().toISOString()} [${scope}] ERROR ${msg}${detail}`)
  console.error(line)
  write(line)
}
