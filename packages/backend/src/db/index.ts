import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { schema } from './schema.js';

export type ArenaDatabase = BetterSQLite3Database<typeof schema>;

export function openArenaDatabase(path = process.env.ARENA_DB ?? './arena.db'): {
  database: ArenaDatabase;
  sqlite: Database.Database;
} {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      preset TEXT NOT NULL,
      started_at TEXT,
      deadline_at TEXT,
      duration_ms INTEGER,
      seeded_by TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entrants (
      run_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'hosted',
      harness TEXT,
      model TEXT,
      effort TEXT,
      address TEXT,
      status TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS entrants_run_id_id ON entrants (run_id, id);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS events_run_id_source_seq ON events (run_id, source, seq);
    CREATE INDEX IF NOT EXISTS events_run_id_id ON events (run_id, id);
    CREATE INDEX IF NOT EXISTS events_run_id_type_id ON events (run_id, type, id);
    CREATE INDEX IF NOT EXISTS events_run_id_source_id ON events (run_id, source, id);
  `);
  // A pre-roster arena.db has entrants without the effort column, and
  // CREATE TABLE IF NOT EXISTS never adds it to an existing table.
  const entrantColumns = sqlite.prepare('PRAGMA table_info(entrants)').all() as Array<{ name: string; notnull: number }>;
  if (!entrantColumns.some((column) => column.name === 'effort')) {
    sqlite.exec('ALTER TABLE entrants ADD COLUMN effort TEXT');
  }
  if (!entrantColumns.some((column) => column.name === 'kind')) {
    sqlite.exec("ALTER TABLE entrants ADD COLUMN kind TEXT NOT NULL DEFAULT 'hosted'");
  }
  // SQLite cannot drop NOT NULL in place. Rebuild only legacy entrant tables.
  if (entrantColumns.some((column) => (column.name === 'harness' || column.name === 'model') && column.notnull === 1)) {
    const hasRunReference = sqlite.prepare('PRAGMA foreign_key_list(entrants)').all().length > 0;
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE entrants_next (
          run_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'hosted',
          harness TEXT, model TEXT, effort TEXT, address TEXT, status TEXT NOT NULL
          ${hasRunReference ? ', FOREIGN KEY (run_id) REFERENCES runs(id)' : ''}
        );
        INSERT INTO entrants_next SELECT run_id, id, kind, harness, CASE WHEN kind = 'external' THEN NULL ELSE model END, effort, address, status FROM entrants;
        DROP TABLE entrants;
        ALTER TABLE entrants_next RENAME TO entrants;
        CREATE UNIQUE INDEX entrants_run_id_id ON entrants (run_id, id);
      `);
    })();
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS external_entrants (
      run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, address TEXT NOT NULL COLLATE NOCASE,
      name TEXT NOT NULL, harness TEXT, model TEXT, effort TEXT, url TEXT, token_hash TEXT,
      flags_before_join INTEGER NOT NULL, joined_at TEXT NOT NULL, removed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS external_entrants_run_id_id ON external_entrants (run_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS external_entrants_run_id_address ON external_entrants (run_id, address);
    CREATE UNIQUE INDEX IF NOT EXISTS external_entrants_token_hash ON external_entrants (token_hash);
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
      entrant_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT
    );
  `);
  const runColumns = sqlite.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string; notnull: number }>;
  if (!runColumns.some((column) => column.name === 'duration_ms')) {
    sqlite.exec('ALTER TABLE runs ADD COLUMN duration_ms INTEGER');
  }
  if (!runColumns.some((column) => column.name === 'seeded_by')) {
    sqlite.exec('ALTER TABLE runs ADD COLUMN seeded_by TEXT');
  }
  return { database: drizzle(sqlite, { schema }), sqlite };
}
