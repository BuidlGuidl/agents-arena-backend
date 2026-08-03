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
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entrants (
      run_id TEXT NOT NULL,
      id TEXT NOT NULL,
      harness TEXT NOT NULL,
      model TEXT NOT NULL,
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
  return { database: drizzle(sqlite, { schema }), sqlite };
}
