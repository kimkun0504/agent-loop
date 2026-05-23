/**
 * `agent-loop stop [--clear]` — fleshed out in CLI step 5.
 */

export interface StopOptions {
  clear?: boolean;
}

export async function stop(_opts: StopOptions): Promise<number> {
  process.stderr.write('stop: not yet implemented (CLI step 5)\n');
  return 1;
}
