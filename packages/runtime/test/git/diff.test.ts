import { describe, expect, it, vi } from 'vitest';
import { getDiffSinceBase } from '../../src/git/diff.js';
import type { RunCommandResult } from '../../src/proc/run.js';

function ok(stdout: string): RunCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  };
}

function fail(): RunCommandResult {
  return {
    exitCode: 128,
    stdout: '',
    stderr: 'not a git repo',
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  };
}

describe('getDiffSinceBase', () => {
  it('runs `git diff <base>..HEAD` with default base=main', async () => {
    const spy = vi.fn(async () => ok('diff body'));
    const diff = await getDiffSinceBase({ cwd: '/x', runner: spy });
    expect(diff).toBe('diff body');
    expect(spy).toHaveBeenCalledWith('git', ['diff', 'main..HEAD'], {
      cwd: '/x',
      timeoutMs: 30_000,
    });
  });

  it('honors a custom baseRef', async () => {
    const spy = vi.fn(async () => ok('d'));
    await getDiffSinceBase({ cwd: '/x', baseRef: 'origin/main', runner: spy });
    expect(spy).toHaveBeenCalledWith(
      'git',
      ['diff', 'origin/main..HEAD'],
      expect.anything(),
    );
  });

  it('returns empty string when git fails (not a repo, missing ref)', async () => {
    const spy = vi.fn(async () => fail());
    const diff = await getDiffSinceBase({ cwd: '/x', runner: spy });
    expect(diff).toBe('');
  });

  it('returns empty string when git times out', async () => {
    const spy = vi.fn(async (): Promise<RunCommandResult> => ({
      exitCode: -1,
      stdout: '',
      stderr: '',
      durationMs: 30000,
      timedOut: true,
      spawnFailed: false,
    }));
    const diff = await getDiffSinceBase({ cwd: '/x', runner: spy });
    expect(diff).toBe('');
  });
});
