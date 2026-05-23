/**
 * `agent-loop status`
 *
 * Print the most recently updated non-terminal run, if any. Designed for
 * watching demos — `watch -n 1 agent-loop status`.
 */

import { openDb, NON_TERMINAL_PHASES } from '@agent-loop/runtime';
import { resolvePaths, ensureAgentLoopDirs } from '../config.js';
import { formatRunDetail } from '../format.js';

export async function status(): Promise<number> {
  const paths = resolvePaths();
  ensureAgentLoopDirs(paths);
  const store = openDb(paths.dbPath);
  const active = store.listRuns({ phase: [...NON_TERMINAL_PHASES] });
  if (active.length === 0) {
    process.stdout.write('no active runs\n');
    return 0;
  }
  // Most recently updated first.
  const sorted = [...active].sort((a, b) =>
    a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0,
  );
  process.stdout.write(formatRunDetail(sorted[0]!));
  return 0;
}
