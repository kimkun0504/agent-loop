/**
 * `agent-loop inspect <runId>`
 *
 * Prints the full history of a run:
 *   - Run header (phase, version, timestamps, failure if any)
 *   - Spec, if one has been recorded
 *   - Verdicts in chronological order
 *   - Event log in chronological order
 *
 * Exit code 1 if the run id is not found. Exit 0 on success.
 */

import { RunId } from '@agent-loop/core';
import { openDb } from '@agent-loop/runtime';
import { resolvePaths, ensureAgentLoopDirs } from '../config.js';
import {
  formatRunDetail,
  formatSpec,
  formatVerdict,
  formatEventLine,
} from '../format.js';

export async function inspect(runId: string): Promise<number> {
  const paths = resolvePaths();
  ensureAgentLoopDirs(paths);
  const store = openDb(paths.dbPath);

  const id = RunId(runId);
  const run = store.getRun(id);
  if (!run) {
    process.stderr.write(`run not found: ${runId}\n`);
    return 1;
  }

  process.stdout.write(formatRunDetail(run));

  const spec = store.getSpecByRun(id);
  if (spec) {
    process.stdout.write(formatSpec(spec));
  }

  const verdicts = store.listVerdicts(id);
  verdicts.forEach((v, i) => {
    process.stdout.write(formatVerdict(v, i));
  });

  const events = store.listEvents(id);
  if (events.length > 0) {
    process.stdout.write('--- Events ------------------------------------------------\n');
    for (const e of events) {
      process.stdout.write(formatEventLine(e) + '\n');
    }
  }

  return 0;
}
