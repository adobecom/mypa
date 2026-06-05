import type Database from 'better-sqlite3'

export function initSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS routines (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      cron        TEXT NOT NULL,
      actions     TEXT NOT NULL DEFAULT '[]',
      prompt      TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routine_runs (
      id           TEXT PRIMARY KEY,
      routine_id   TEXT NOT NULL,
      routine_name TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      completed_at TEXT,
      raw_output   TEXT,
      digest       TEXT,
      status       TEXT NOT NULL DEFAULT 'running',
      error        TEXT,
      FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS routine_run_threads (
      id         TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES routine_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plan_items (
      id             TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      detail         TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'pending',
      timing         TEXT NOT NULL DEFAULT 'anytime',
      source         TEXT NOT NULL DEFAULT 'manual_input',
      created_at     TEXT NOT NULL,
      actions        TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS plan_item_threads (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES plan_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plan_item_history (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status  TEXT NOT NULL,
      timestamp  TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES plan_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine_id ON routine_runs(routine_id);
    CREATE INDEX IF NOT EXISTS idx_routine_run_threads_run_id ON routine_run_threads(run_id);
    CREATE INDEX IF NOT EXISTS idx_plan_item_threads_item_id ON plan_item_threads(item_id);
    CREATE INDEX IF NOT EXISTS idx_plan_items_status ON plan_items(status);
  `)
}
