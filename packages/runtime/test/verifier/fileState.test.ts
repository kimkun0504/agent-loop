import { describe, expect, it, vi } from 'vitest';
import { runFileStateChecks } from '../../src/verifier/fileState.js';
import type { RunCommandResult } from '../../src/proc/run.js';

function ok(): RunCommandResult {
  return {
    exitCode: 0, stdout: '', stderr: '', durationMs: 1,
    timedOut: false, spawnFailed: false,
  };
}

function fail(code = 1): RunCommandResult {
  return {
    exitCode: code, stdout: '', stderr: 'fail', durationMs: 1,
    timedOut: false, spawnFailed: false,
  };
}

describe('runFileStateChecks: shell translation per type', () => {
  it('unchanged → `git diff --quiet main -- <path>`', async () => {
    const spy = vi.fn(async () => ok());
    await runFileStateChecks(
      [{ type: 'unchanged', path: 'src/foo.js' }],
      { cwd: '/x', runner: spy },
    );
    expect(spy).toHaveBeenCalledWith(
      'git',
      ['diff', '--quiet', 'main', '--', 'src/foo.js'],
      expect.objectContaining({ cwd: '/x' }),
    );
  });

  it('honors custom baseRef for unchanged', async () => {
    const spy = vi.fn(async () => ok());
    await runFileStateChecks(
      [{ type: 'unchanged', path: 'src/foo.js' }],
      { cwd: '/x', baseRef: 'origin/main', runner: spy },
    );
    expect(spy).toHaveBeenCalledWith(
      'git',
      ['diff', '--quiet', 'origin/main', '--', 'src/foo.js'],
      expect.anything(),
    );
  });

  it('deleted → `test ! -f <path>`', async () => {
    const spy = vi.fn(async () => ok());
    await runFileStateChecks(
      [{ type: 'deleted', path: 'src/old.js' }],
      { cwd: '/x', runner: spy },
    );
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe('sh');
    expect(call?.[1][0]).toBe('-c');
    expect(call?.[1][1]).toBe(`test ! -f 'src/old.js'`);
  });

  it('exists → `test -f <path>`', async () => {
    const spy = vi.fn(async () => ok());
    await runFileStateChecks(
      [{ type: 'exists', path: 'src/new.js' }],
      { cwd: '/x', runner: spy },
    );
    expect(spy.mock.calls[0]?.[1][1]).toBe(`test -f 'src/new.js'`);
  });

  it('absent → `test ! -f <path>` (same shell as deleted; semantic distinction is in authorship)', async () => {
    const spy = vi.fn(async () => ok());
    await runFileStateChecks(
      [{ type: 'absent', path: 'src/never.js' }],
      { cwd: '/x', runner: spy },
    );
    expect(spy.mock.calls[0]?.[1][1]).toBe(`test ! -f 'src/never.js'`);
  });

  it('shell-quotes paths containing single quotes', async () => {
    const spy = vi.fn(async () => ok());
    await runFileStateChecks(
      [{ type: 'exists', path: "src/o'brien.js" }],
      { cwd: '/x', runner: spy },
    );
    // Single quotes inside single-quoted strings need closing+escape+reopening.
    expect(spy.mock.calls[0]?.[1][1]).toBe(`test -f 'src/o'\\''brien.js'`);
  });
});

describe('runFileStateChecks: aggregation', () => {
  it('all pass → pass:true with per-check results', async () => {
    const spy = vi.fn(async () => ok());
    const r = await runFileStateChecks(
      [
        { type: 'unchanged', path: 'a' },
        { type: 'exists', path: 'b' },
        { type: 'deleted', path: 'c' },
      ],
      { cwd: '/x', runner: spy },
    );
    expect(r.pass).toBe(true);
    expect(r.results).toHaveLength(3);
    expect(r.results.every((res) => res.passed)).toBe(true);
  });

  it('any fail → pass:false but all results recorded', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok());
    const r = await runFileStateChecks(
      [
        { type: 'unchanged', path: 'a' },
        { type: 'exists', path: 'b' },
        { type: 'deleted', path: 'c' },
      ],
      { cwd: '/x', runner: spy },
    );
    expect(r.pass).toBe(false);
    expect(r.results).toHaveLength(3);
    expect(r.results[0]?.passed).toBe(true);
    expect(r.results[1]?.passed).toBe(false);
    expect(r.results[2]?.passed).toBe(true);
  });

  it('empty checks array → pass:true with empty results', async () => {
    const spy = vi.fn();
    const r = await runFileStateChecks([], { cwd: '/x', runner: spy });
    expect(r.pass).toBe(true);
    expect(r.results).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('records each check\'s command + exit code in the result', async () => {
    const spy = vi.fn().mockResolvedValueOnce(fail(127));
    const r = await runFileStateChecks(
      [{ type: 'unchanged', path: 'src/foo.js' }],
      { cwd: '/x', runner: spy },
    );
    expect(r.results[0]?.command).toBe('git diff --quiet main -- src/foo.js');
    expect(r.results[0]?.exitCode).toBe(127);
  });
});

describe('runFileStateChecks: edge cases', () => {
  it('timed-out check is marked passed:false even on exitCode 0', async () => {
    const spy = vi.fn(async (): Promise<RunCommandResult> => ({
      exitCode: 0, stdout: '', stderr: '', durationMs: 30000,
      timedOut: true, spawnFailed: false,
    }));
    const r = await runFileStateChecks(
      [{ type: 'exists', path: 'foo' }],
      { cwd: '/x', runner: spy },
    );
    expect(r.results[0]?.passed).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('spawn-failed check is marked passed:false', async () => {
    const spy = vi.fn(async (): Promise<RunCommandResult> => ({
      exitCode: -1, stdout: '', stderr: 'not found', durationMs: 0,
      timedOut: false, spawnFailed: true,
    }));
    const r = await runFileStateChecks(
      [{ type: 'exists', path: 'foo' }],
      { cwd: '/x', runner: spy },
    );
    expect(r.results[0]?.passed).toBe(false);
    expect(r.pass).toBe(false);
  });
});
