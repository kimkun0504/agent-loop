import { describe, expect, it, vi } from 'vitest';
import { runCalibrationAnchor } from '../../src/verifier/calibrationAnchor.js';
import type { RunCommandResult } from '../../src/proc/run.js';

function ok(): RunCommandResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  };
}

function fail(): RunCommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'fail',
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  };
}

describe('runCalibrationAnchor', () => {
  it('runs each command sequentially via bash -c', async () => {
    const calls: string[] = [];
    const spy = async (
      _cmd: string,
      args: string[],
    ): Promise<RunCommandResult> => {
      calls.push(args[1] ?? '');
      return ok();
    };
    await runCalibrationAnchor(
      ['echo a', 'echo b'],
      { exitCodePass: true, semanticMatches: true },
      { cwd: '/x', runner: spy },
    );
    expect(calls).toEqual(['echo a', 'echo b']);
  });

  it('aggregates exit codes and anchorPass=true iff all zero', async () => {
    const spy = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    const result = await runCalibrationAnchor(
      ['a', 'b'],
      { exitCodePass: true, semanticMatches: true },
      { cwd: '/x', runner: spy },
    );
    expect(result.exitCodes).toEqual([0, 0]);
    expect(result.anchorPass).toBe(true);
    expect(result.agreement).toBe(true);
  });

  it('flags disagreement when anchor passes but semantic fails', async () => {
    const spy = vi.fn().mockResolvedValueOnce(ok());
    const lines: Array<{ level: string; msg: string }> = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => lines.push({ level: 'warn', msg }),
      error: () => {},
      debug: () => {},
      child: () => logger,
    } as never;
    const result = await runCalibrationAnchor(
      ['a'],
      { exitCodePass: true, semanticMatches: false },
      { cwd: '/x', runner: spy, logger },
    );
    expect(result.agreement).toBe(false);
    expect(result.anchorPass).toBe(true);
    expect(
      lines.some((l) => l.msg === 'verifier: calibration disagreement'),
    ).toBe(true);
  });

  it('flags POTENTIAL FALSE POSITIVE direction when anchor fails but semantic passes', async () => {
    const spy = vi.fn().mockResolvedValueOnce(fail());
    const lines: Array<{ ctx: Record<string, unknown> }> = [];
    const logger = {
      info: () => {},
      warn: (_msg: string, ctx: Record<string, unknown>) =>
        lines.push({ ctx }),
      error: () => {},
      debug: () => {},
      child: () => logger,
    } as never;
    const result = await runCalibrationAnchor(
      ['a'],
      { exitCodePass: true, semanticMatches: true },
      { cwd: '/x', runner: spy, logger },
    );
    expect(result.agreement).toBe(false);
    expect(result.anchorPass).toBe(false);
    expect(lines[0]?.ctx['direction']).toMatch(/POTENTIAL FALSE POSITIVE/);
  });

  it('no warn log when both sides agree', async () => {
    const spy = vi.fn().mockResolvedValueOnce(fail());
    const lines: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => lines.push(msg),
      error: () => {},
      debug: () => {},
      child: () => logger,
    } as never;
    await runCalibrationAnchor(
      ['a'],
      { exitCodePass: true, semanticMatches: false },
      { cwd: '/x', runner: spy, logger },
    );
    // anchor fail, semantic fail (false && exitCodePass true overall = ... pass false; anchor false; agreement true)
    expect(lines).toEqual([]);
  });
});
