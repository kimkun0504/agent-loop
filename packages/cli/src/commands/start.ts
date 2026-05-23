/**
 * `agent-loop start --spec <name> --target <path>` — fleshed out in CLI step 7.
 */

export interface StartOptions {
  spec: string;
  target: string;
}

export async function start(_opts: StartOptions): Promise<number> {
  process.stderr.write('start: not yet implemented (CLI step 7)\n');
  return 1;
}
