/**
 * `agent-loop stop [--clear]`
 *
 * Default: write an empty STOP file at `<home>/STOP`. The orchestrator
 * loop checks for this between phases and exits cleanly when present.
 *
 * --clear: remove the STOP file. Idempotent — no error if it's not there.
 */

import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolvePaths, ensureAgentLoopDirs } from '../config.js';

export interface StopOptions {
  clear?: boolean;
}

export async function stop(opts: StopOptions): Promise<number> {
  const paths = resolvePaths();
  ensureAgentLoopDirs(paths);

  if (opts.clear) {
    if (existsSync(paths.stopFilePath)) {
      rmSync(paths.stopFilePath);
      process.stdout.write(`cleared STOP file at ${paths.stopFilePath}\n`);
    } else {
      process.stdout.write('no STOP file present\n');
    }
    return 0;
  }

  writeFileSync(paths.stopFilePath, '');
  process.stdout.write(`wrote STOP file to ${paths.stopFilePath}\n`);
  return 0;
}
