import { vi } from 'vitest'

// Global electron mock — many main-process modules import `electron` at the top
// (app.getPath, Notification, safeStorage, shell) purely for side-effect-free
// references, but the import itself fails under plain Node/Vitest without this.
// See docs-dev/testing.md for the full rationale.
vi.mock('electron', () => {
  class BrowserWindow {}

  class Notification {
    constructor(_opts?: unknown) {}
    on(): void {}
    show(): void {}
  }

  const app = {
    getPath: vi.fn(() => '/tmp/mypa-test'),
    getName: vi.fn(() => 'mypa-test'),
    getVersion: vi.fn(() => '0.0.0-test')
  }

  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8'))
  }

  const shell = {
    openExternal: vi.fn(),
    openPath: vi.fn()
  }

  const mocked = { app, BrowserWindow, Notification, safeStorage, shell }
  return { ...mocked, default: mocked }
})
