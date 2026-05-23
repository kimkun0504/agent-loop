/**
 * Smoke test for the CLI scaffold: every documented subcommand is wired,
 * --help works, and the bin shim resolves tsx.
 *
 * Spawns the bin script via the project's package.json to exercise the
 * real invocation path. Fast: each subcommand is a no-op stub that exits
 * within ~30ms.
 */

import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(
  fileURLToPath(new URL('../bin/agent-loop', import.meta.url)),
);

async function run(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const res = await execa(BIN, args, { reject: false });
  return {
    exitCode: res.exitCode ?? -1,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

describe('cli scaffold', () => {
  it('--help prints usage with all five subcommands', async () => {
    const r = await run(['--help']);
    expect(r.exitCode).toBe(0);
    for (const cmd of ['start', 'list', 'inspect', 'stop', 'status']) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it('--version prints 0.0.1', async () => {
    const r = await run(['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('0.0.1');
  });

  it('start requires --spec and --target', async () => {
    const r = await run(['start']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/required option/);
  });

  it('start: real command, refuses unknown spec', async () => {
    const r = await run(['start', '--spec', 'x', '--target', '/tmp']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toLowerCase()).toContain('unknown spec');
  });

  it('unknown subcommand exits non-zero', async () => {
    const r = await run(['nope']);
    expect(r.exitCode).not.toBe(0);
  });
});
