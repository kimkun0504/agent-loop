/**
 * Migration runner.
 *
 * Applies the MIGRATIONS array from @agent-loop/core in id order, tracking
 * which migrations have been applied in the _migrations table. Idempotent:
 * re-running is a no-op once everything is applied.
 *
 * Each migration runs in its own transaction so a failure leaves the database
 * at the last known-good version, never half-applied.
 */

import type Database from 'better-sqlite3';
import { MIGRATIONS } from '@agent-loop/core';

export interface AppliedMigration {
  id: number;
  name: string;
  appliedAt: string;
}

const DEFAULT_NOW = (): string => new Date().toISOString();

export function applyMigrations(
  db: Database.Database,
  now: () => string = DEFAULT_NOW,
): AppliedMigration[] {
  // We cannot read _migrations before it exists. Migration #1 creates it
  // (with IF NOT EXISTS), but we also create it explicitly here so we can
  // query "what's already applied" before running the first migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedIds = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );

  const recordApplied = db.prepare(
    'INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  const newlyApplied: AppliedMigration[] = [];

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;

    const appliedAt = now();
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      recordApplied.run(migration.id, migration.name, appliedAt);
    });
    apply();

    newlyApplied.push({
      id: migration.id,
      name: migration.name,
      appliedAt,
    });
  }

  return newlyApplied;
}
