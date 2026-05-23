import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/db/migrate.js';
import { MIGRATIONS } from '@agent-loop/core';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe('applyMigrations', () => {
  it('creates all expected tables on a fresh database', () => {
    const db = freshDb();
    applyMigrations(db);

    const tables = tableNames(db);
    expect(tables).toContain('runs');
    expect(tables).toContain('events');
    expect(tables).toContain('specs');
    expect(tables).toContain('plans');
    expect(tables).toContain('verdicts');
    expect(tables).toContain('_migrations');
  });

  it('creates the expected indexes', () => {
    const db = freshDb();
    applyMigrations(db);

    const indexes = indexNames(db);
    expect(indexes).toContain('idx_runs_phase');
    expect(indexes).toContain('idx_runs_task');
    expect(indexes).toContain('idx_events_run');
    expect(indexes).toContain('idx_verdicts_run');
  });

  it('records every applied migration in _migrations', () => {
    const db = freshDb();
    applyMigrations(db, () => '2026-01-01T00:00:00.000Z');

    const rows = db
      .prepare('SELECT id, name, applied_at FROM _migrations ORDER BY id')
      .all() as { id: number; name: string; applied_at: string }[];

    expect(rows.length).toBe(MIGRATIONS.length);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(rows[i]!.id).toBe(MIGRATIONS[i]!.id);
      expect(rows[i]!.name).toBe(MIGRATIONS[i]!.name);
      expect(rows[i]!.applied_at).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('returns the set of newly-applied migrations', () => {
    const db = freshDb();
    const applied = applyMigrations(db, () => '2026-01-01T00:00:00.000Z');
    expect(applied.map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(applied.map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it('is idempotent — second call applies nothing', () => {
    const db = freshDb();
    applyMigrations(db);
    const second = applyMigrations(db);
    expect(second).toEqual([]);
  });

  it('only applies pending migrations, not already-applied ones', () => {
    const db = freshDb();
    // Simulate having applied only migration #1 by hand.
    db.exec(MIGRATIONS[0]!.sql);
    db.prepare(
      'INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)',
    ).run(1, 'initial', '2026-01-01T00:00:00.000Z');

    const applied = applyMigrations(db);
    expect(applied.length).toBe(MIGRATIONS.length - 1);
    expect(applied[0]?.id).toBe(2);
  });

  it('enforces foreign keys on the runs->events relationship after migrate', () => {
    const db = freshDb();
    applyMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (run_id, event_type, payload, applied_at, run_version_after)
           VALUES ('nonexistent', 'start_triage', '{}', '2026-01-01T00:00:00Z', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('runs.pr_url column exists and is nullable after migration #3', () => {
    const db = freshDb();
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const prUrl = cols.find((c) => c.name === 'pr_url');
    expect(prUrl).toBeDefined();
    expect(prUrl?.notnull).toBe(0); // nullable
  });
});
