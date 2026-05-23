/**
 * The STOP file is the orchestrator's kill switch. Touching `STOP` in the
 * working directory halts new work before the next phase begins. Single
 * character to type, zero ceremony to undo (`rm STOP`).
 *
 * Sync existsSync because the check is called once per tick between phases
 * — not in a hot loop, but we don't want to add an async hop either.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const STOP_FILE_NAME = 'STOP';

export function isStopRequested(cwd: string): boolean {
  return existsSync(join(cwd, STOP_FILE_NAME));
}
