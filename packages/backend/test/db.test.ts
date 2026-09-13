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
  it('creates external entrant and inbox storage on a fresh database', () => {
    const { sqlite } = openArenaDatabase(':memory:');
    try {
      const columns = (table: string) => sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
      expect(columns('entrants')).toContainEqual(expect.objectContaining({ name: 'kind', notnull: 1 }));
      expect(columns('entrants')).toContainEqual(expect.objectContaining({ name: 'harness', notnull: 0 }));
      expect(columns('entrants')).toContainEqual(expect.objectContaining({ name: 'model', notnull: 0 }));
      expect(columns('external_entrants').map((column) => column.name)).toEqual([
        'run_id', 'id', 'address', 'name', 'harness', 'model', 'effort', 'url',
        'flags_before_join', 'joined_at', 'removed_at',
      ]);
      expect(columns('agent_tokens').map((column) => column.name)).toEqual(['address', 'token_hash', 'created_at', 'expires_at']);
      expect(columns('inbox_messages').map((column) => column.name)).toEqual([
        'id', 'run_id', 'entrant_id', 'kind', 'text', 'created_at', 'delivered_at',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('keeps token hashes unique across wallets and finds tokens after reopening regardless of address case', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-db-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'arena.db');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sqlite } = openArenaDatabase(path);
      try {
        if (attempt === 0) {
          sqlite.prepare('INSERT INTO agent_tokens VALUES (?, ?, ?, ?)').run('0xAb', 'new-hash', 'now', 'later');
          expect(() => sqlite.prepare('INSERT INTO agent_tokens VALUES (?, ?, ?, ?)').run('0xab', 'other-hash', 'now', 'later')).toThrow();
          expect(() => sqlite.prepare('INSERT INTO agent_tokens VALUES (?, ?, ?, ?)').run('0xCd', 'new-hash', 'now', 'later')).toThrow();
        }
        expect(sqlite.prepare('SELECT token_hash FROM agent_tokens WHERE address = ?').get('0xab')).toEqual({ token_hash: 'new-hash' });
      } finally {
        sqlite.close();
      }
    }
  });

  it('preserves legacy entrants and their foreign key while allowing null harness and model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-db-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'arena.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, preset TEXT NOT NULL,
        started_at TEXT, deadline_at TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL);
      INSERT INTO runs VALUES ('run-1', 'created', 'fake-duel', NULL, NULL, NULL, 'now');
      CREATE TABLE entrants (run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL,
        harness TEXT NOT NULL, model TEXT NOT NULL, address TEXT, status TEXT NOT NULL);
      INSERT INTO entrants VALUES ('run-1', 'host', 'codex', 'gpt-5.5', NULL, 'idle');
    `);
    legacy.close();
    const { sqlite } = openArenaDatabase(path);
    try {
      expect(sqlite.prepare('SELECT kind, harness, effort FROM entrants').get())
        .toEqual({ kind: 'hosted', harness: 'codex', effort: null });
      sqlite.exec("INSERT INTO entrants (run_id, id, kind, harness, model, status) VALUES ('run-1', 'ext-1', 'external', NULL, NULL, 'idle')");
      expect(sqlite.prepare('PRAGMA foreign_key_list(entrants)').all()).toHaveLength(1);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      sqlite.close();
    }
    const reopened = openArenaDatabase(path);
    expect(reopened.sqlite.prepare('SELECT count(*) AS n FROM entrants').get()).toEqual({ n: 2 });
    reopened.sqlite.close();
  });

  it('migrates slice A external models from empty strings to null', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-db-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'arena.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE entrants (run_id TEXT NOT NULL, id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'hosted', harness TEXT, model TEXT NOT NULL,
        effort TEXT, address TEXT, status TEXT NOT NULL);
      INSERT INTO entrants VALUES ('run-1', 'ext-1', 'external', NULL, '', NULL, NULL, 'idle');
      INSERT INTO entrants VALUES ('run-1', 'host', 'hosted', 'codex', 'gpt-5.5', NULL, NULL, 'idle');
    `);
    legacy.close();
    const { sqlite } = openArenaDatabase(path);
    try {
      expect(sqlite.prepare('SELECT id, model FROM entrants ORDER BY id').all()).toEqual([
        { id: 'ext-1', model: null }, { id: 'host', model: 'gpt-5.5' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('adds duration_ms and seeded_by to an existing runs table', async () => {
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
        'INSERT INTO runs (id, state, preset, duration_ms, seeded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'run-1',
        'created',
        'fake-duel',
        60_000,
        '0x0000000000000000000000000000000000000001',
        new Date().toISOString(),
      );
      const row = sqlite.prepare('SELECT duration_ms, seeded_by FROM runs WHERE id = ?').get('run-1') as {
        duration_ms: number;
        seeded_by: string;
      };
      expect(row.duration_ms).toBe(60_000);
      expect(row.seeded_by).toBe('0x0000000000000000000000000000000000000001');
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
