/**
 * `agent-loop list`
 *
 * Print all runs in the DB as a fixed-width table, most recent first.
 */

import { openDb } from '@agent-loop/runtime';
import { resolvePaths, ensureAgentLoopDirs } from '../config.js';
import { formatRunsTable } from '../format.js';

export async function list(): Promise<number> {
  const paths = resolvePaths();
  ensureAgentLoopDirs(paths);
  const store = openDb(paths.dbPath);
  const runs = store.listRuns();
  if (runs.length === 0) {
    process.stdout.write('no runs yet\n');
    return 0;
  }
  process.stdout.write(formatRunsTable(runs));
  return 0;
}
