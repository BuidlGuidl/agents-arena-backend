import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openArenaDatabase } from '../src/db/index.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('openArenaDatabase', () => {
  it('adds duration_ms to an existing runs table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-db-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'arena.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        preset TEXT NOT NULL,
        started_at TEXT,
        deadline_at TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const { sqlite } = openArenaDatabase(path);
    try {
      sqlite.prepare(
        'INSERT INTO runs (id, state, preset, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('run-1', 'created', 'fake-duel', 60_000, new Date().toISOString());
      const row = sqlite.prepare('SELECT duration_ms FROM runs WHERE id = ?').get('run-1') as {
        duration_ms: number;
      };
      expect(row.duration_ms).toBe(60_000);
    } finally {
      sqlite.close();
    }
  });

  it('adds the effort column to a database created before rosters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-db-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'arena.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE entrants (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        harness TEXT NOT NULL,
        model TEXT NOT NULL,
        address TEXT,
        status TEXT NOT NULL
      );
    `);
    legacy.close();

    const { sqlite } = openArenaDatabase(path);
    try {
      sqlite.prepare(
        'INSERT INTO entrants (run_id, id, harness, model, effort, address, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('run-1', 'codex-1', 'codex', 'gpt-5.5', 'high', null, 'idle');
      const row = sqlite.prepare('SELECT effort FROM entrants WHERE id = ?').get('codex-1') as { effort: string };
      expect(row.effort).toBe('high');
    } finally {
      sqlite.close();
    }
  });
});
