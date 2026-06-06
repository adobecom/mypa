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

    -- ─── Ambient Intelligence ─────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS signals (
      id           TEXT PRIMARY KEY,
      surface      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      body         TEXT NOT NULL DEFAULT '',
      actor        TEXT NOT NULL DEFAULT '',
      url          TEXT NOT NULL DEFAULT '',
      raw          TEXT NOT NULL DEFAULT '{}',
      occurred_at  TEXT,
      observed_at  TEXT NOT NULL,
      processed    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (surface, external_id)
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      key        TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      attrs      TEXT NOT NULL DEFAULT '{}',
      weight     REAL NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      UNIQUE (type, key)
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id         TEXT PRIMARY KEY,
      src_id     TEXT NOT NULL,
      dst_id     TEXT NOT NULL,
      rel        TEXT NOT NULL,
      weight     REAL NOT NULL DEFAULT 0,
      attrs      TEXT NOT NULL DEFAULT '{}',
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      UNIQUE (src_id, dst_id, rel),
      FOREIGN KEY (src_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (dst_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS intents (
      id               TEXT PRIMARY KEY,
      type             TEXT NOT NULL,
      trigger_kind     TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 0,
      surface          TEXT,
      verb             TEXT,
      target           TEXT,
      payload          TEXT NOT NULL DEFAULT '{}',
      rationale        TEXT NOT NULL DEFAULT '',
      reversibility    TEXT NOT NULL DEFAULT 'reversible',
      required_approval INTEGER NOT NULL DEFAULT 1,
      tier             INTEGER NOT NULL DEFAULT 2,
      status           TEXT NOT NULL DEFAULT 'pending',
      context_packet   TEXT NOT NULL DEFAULT '{}',
      created_at       TEXT NOT NULL,
      resolved_at      TEXT,
      error            TEXT
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id          TEXT PRIMARY KEY,
      intent_id   TEXT,
      event       TEXT NOT NULL,
      action_type TEXT NOT NULL DEFAULT '',
      tier        INTEGER,
      detail      TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS autonomy_policy (
      action_type           TEXT PRIMARY KEY,
      tier                  INTEGER NOT NULL DEFAULT 2,
      tier_locked           INTEGER NOT NULL DEFAULT 0,
      approvals             INTEGER NOT NULL DEFAULT 0,
      consecutive_approvals INTEGER NOT NULL DEFAULT 0,
      challenges            INTEGER NOT NULL DEFAULT 0,
      dismissals            INTEGER NOT NULL DEFAULT 0,
      executions            INTEGER NOT NULL DEFAULT 0,
      updated_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_signals (
      id          TEXT PRIMARY KEY,
      node_id     TEXT NOT NULL,
      signal_id   TEXT NOT NULL,
      surface     TEXT NOT NULL DEFAULT '',
      summary     TEXT NOT NULL DEFAULT '',
      occurred_at TEXT,
      observed_at TEXT NOT NULL,
      UNIQUE (node_id, signal_id),
      FOREIGN KEY (node_id)   REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (signal_id) REFERENCES signals(id)     ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      content       TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'fact',
      confidence    REAL NOT NULL DEFAULT 0.5,
      importance    REAL NOT NULL DEFAULT 0.5,
      surface       TEXT NOT NULL DEFAULT '',
      node_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      superseded_by TEXT,
      created_at    TEXT NOT NULL,
      last_accessed TEXT,
      FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_signals_unprocessed ON signals(processed, observed_at);
    CREATE INDEX IF NOT EXISTS idx_signals_surface ON signals(surface, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(src_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst_id);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_weight ON graph_nodes(weight);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_last_seen ON graph_nodes(last_seen);
    CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_action_log_type ON action_log(action_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_node_signals_node ON node_signals(node_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(status, importance);
    CREATE INDEX IF NOT EXISTS idx_memories_node   ON memories(node_id);
  `)

  // Schema migrations — add columns introduced after initial table creation.
  // SQLite throws if the column already exists; that's expected and safe to ignore.
  const tryExec = (sql: string): void => { try { db.exec(sql) } catch { /* already exists */ } }
  tryExec('ALTER TABLE autonomy_policy ADD COLUMN consecutive_approvals INTEGER NOT NULL DEFAULT 0')
  // Embedding columns on signals — nullable so old rows remain valid immediately
  tryExec('ALTER TABLE signals ADD COLUMN embedding BLOB')
  tryExec('ALTER TABLE signals ADD COLUMN embedding_model TEXT')

  // Migrate signals from old UNIQUE(surface, external_id, fingerprint) → UNIQUE(surface, external_id).
  // The 3-column constraint allowed duplicate (surface, external_id) rows to accumulate, causing
  // UPDATE to fail when it tried to set a fingerprint that already existed on a sibling row.
  const sigSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='signals'").get() as any)?.sql ?? ''
  if (sigSql.includes('UNIQUE (surface, external_id, fingerprint)')) {
    db.pragma('foreign_keys = OFF')
    db.exec(`
      CREATE TABLE signals_mig (
        id           TEXT PRIMARY KEY,
        surface      TEXT NOT NULL,
        kind         TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        fingerprint  TEXT NOT NULL,
        title        TEXT NOT NULL DEFAULT '',
        body         TEXT NOT NULL DEFAULT '',
        actor        TEXT NOT NULL DEFAULT '',
        url          TEXT NOT NULL DEFAULT '',
        raw          TEXT NOT NULL DEFAULT '{}',
        occurred_at  TEXT,
        observed_at  TEXT NOT NULL,
        processed    INTEGER NOT NULL DEFAULT 0,
        embedding    BLOB,
        embedding_model TEXT,
        UNIQUE (surface, external_id)
      );
      INSERT OR IGNORE INTO signals_mig
        SELECT id, surface, kind, external_id, fingerprint, title, body, actor, url, raw,
               occurred_at, observed_at, processed, embedding, embedding_model
        FROM signals ORDER BY observed_at DESC;
      DELETE FROM node_signals WHERE signal_id NOT IN (SELECT id FROM signals_mig);
      DROP TABLE signals;
      ALTER TABLE signals_mig RENAME TO signals;
      CREATE INDEX IF NOT EXISTS idx_signals_unprocessed ON signals(processed, observed_at);
      CREATE INDEX IF NOT EXISTS idx_signals_surface ON signals(surface, occurred_at);
    `)
    db.pragma('foreign_keys = ON')
  }
}
