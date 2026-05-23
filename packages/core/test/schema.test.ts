/**
 * Schema migrations: structural tests.
 *
 * Core is I/O-free (see CLAUDE.md), so we don't execute SQL here. We assert
 * the migration *data* is well-formed. The runtime package's tests are
 * responsible for "tables actually exist after migrate" against real SQLite.
 *
 * The rule we're enforcing: migrations are append-only and never edited.
 * If you find yourself wanting to change a test below to "fix" an existing
 * migration, write a new migration instead.
 */

import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/schema.js';

describe('MIGRATIONS', () => {
  it('has at least one migration', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('uses contiguous, 1-indexed, monotonically increasing ids', () => {
    MIGRATIONS.forEach((m, i) => {
      expect(m.id).toBe(i + 1);
    });
  });

  it('has unique names', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every migration has non-empty SQL', () => {
    for (const m of MIGRATIONS) {
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('migration 1: initial', () => {
  const m = MIGRATIONS.find((x) => x.id === 1);

  it('exists', () => {
    expect(m).toBeDefined();
  });

  it('is named "initial"', () => {
    expect(m?.name).toBe('initial');
  });

  it('creates the foundational tables', () => {
    const sql = m?.sql ?? '';
    for (const table of ['runs', 'events', 'specs', '_migrations']) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
  });
});

describe('migration 2: plans_and_verdicts', () => {
  const m = MIGRATIONS.find((x) => x.id === 2);

  it('exists', () => {
    expect(m).toBeDefined();
  });

  it('is named "plans_and_verdicts"', () => {
    expect(m?.name).toBe('plans_and_verdicts');
  });

  it('creates the plans table', () => {
    expect(m?.sql).toMatch(/CREATE TABLE IF NOT EXISTS plans\b/);
  });

  it('creates the verdicts table', () => {
    expect(m?.sql).toMatch(/CREATE TABLE IF NOT EXISTS verdicts\b/);
  });

  it('declares run_id as the plans primary key (one plan per run)', () => {
    expect(m?.sql).toMatch(/run_id\s+TEXT\s+PRIMARY\s+KEY/);
  });

  it('declares foreign keys back to runs and specs', () => {
    const sql = m?.sql ?? '';
    expect(sql).toMatch(/FOREIGN KEY\s*\(run_id\)\s*REFERENCES runs\(id\)/);
    expect(sql).toMatch(/FOREIGN KEY\s*\(spec_id\)\s*REFERENCES specs\(id\)/);
  });

  it('indexes verdicts by run_id for chronological lookup', () => {
    expect(m?.sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_verdicts_run/);
  });

  it('stores verdicts.pass as INTEGER (SQLite has no boolean)', () => {
    expect(m?.sql).toMatch(/pass\s+INTEGER\s+NOT NULL/);
  });
});

describe('migration 3: runs_pr_url', () => {
  const m = MIGRATIONS.find((x) => x.id === 3);

  it('exists', () => {
    expect(m).toBeDefined();
  });

  it('is named "runs_pr_url"', () => {
    expect(m?.name).toBe('runs_pr_url');
  });

  it('adds a pr_url column to runs (nullable, no default)', () => {
    expect(m?.sql).toMatch(/ALTER TABLE runs ADD COLUMN pr_url TEXT/);
  });
});

describe('migration 4: tasks', () => {
  const m = MIGRATIONS.find((x) => x.id === 4);

  it('exists', () => {
    expect(m).toBeDefined();
  });

  it('is named "tasks"', () => {
    expect(m?.name).toBe('tasks');
  });

  it('creates the tasks table with id as PRIMARY KEY', () => {
    expect(m?.sql).toMatch(/CREATE TABLE IF NOT EXISTS tasks\b/);
    expect(m?.sql).toMatch(/id\s+TEXT\s+PRIMARY\s+KEY/);
  });

  it('requires title, body, source, created_at; allows null url and metadata', () => {
    const sql = m?.sql ?? '';
    expect(sql).toMatch(/title\s+TEXT\s+NOT NULL/);
    expect(sql).toMatch(/body\s+TEXT\s+NOT NULL/);
    expect(sql).toMatch(/source\s+TEXT\s+NOT NULL/);
    expect(sql).toMatch(/created_at\s+TEXT\s+NOT NULL/);
    // url and source_metadata_json declared without NOT NULL = nullable
    expect(sql).toMatch(/url\s+TEXT/);
    expect(sql).toMatch(/source_metadata_json\s+TEXT/);
  });

  it('indexes tasks by source for fast filter-by-source queries', () => {
    expect(m?.sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_tasks_source/);
  });
});
