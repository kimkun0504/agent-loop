/**
 * openDb: the single entry point that opens a SQLite file, applies all
 * pending migrations, and hands back a typed Store.
 *
 * Pragmas:
 * - foreign_keys = ON: SQLite ships with FK enforcement off by default.
 *   The schema declares FKs, so we turn it on per connection.
 * - journal_mode = WAL: better concurrency for the long-running orchestrator
 *   loop alongside CLI inspect commands. Skipped for :memory: (unsupported).
 */

import Database from 'better-sqlite3';
import { applyMigrations } from './migrate.js';
import { Store } from './store.js';

export interface OpenDbOptions {
  /** Clock override for migration timestamps. Defaults to `new Date().toISOString()`. */
  now?: () => string;
}

export function openDb(path: string, opts: OpenDbOptions = {}): Store {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  if (opts.now) {
    applyMigrations(db, opts.now);
  } else {
    applyMigrations(db);
  }
  return new Store(db);
}
