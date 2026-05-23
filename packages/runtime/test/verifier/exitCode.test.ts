import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Run,
  type Spec,
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
} from '@agent-loop/core';
import {
  runExitCodeVerifier,
  summarizeOutput,
} from '../../src/verifier/exitCode.js';

const NOW = '2026-01-01T00:00:00.000Z';

function sampleRun(): Run {
  return {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    artifactDir: '/runs/run-1',
    branch: 'agent/run-1',
    phase: 'verifying',
    version: 5,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  };
}

function specWith(commands: string[]): Spec {
  return {
    id: SpecId('spec-1'),
    runId: RunId('run-1'),
    title: 't',
    description: 'd',
    fileScope: [],
    acceptanceCriteria: [],
    testCommands: commands,
    budget: { ...DEFAULT_BUDGET, maxSeconds: 10 },
    createdAt: NOW,
  };
}

describe('runExitCodeVerifier: aggregation', () => {
  it('pass=true when every command exits 0', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['echo a', 'echo b', 'true']),
      { cwd: process.cwd(), now: () => NOW },
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.testResults).toHaveLength(3);
    expect(verdict.testResults.every((r) => r.exitCode === 0)).toBe(true);
  });

  it('pass=false when any command exits non-zero', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['true', 'false', 'true']),
      { cwd: process.cwd(), now: () => NOW },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.testResults[1]?.exitCode).toBe(1);
  });

  it('runs all commands even after one fails (gathers maximum signal)', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['false', 'echo still-ran']),
      { cwd: process.cwd(), now: () => NOW },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.testResults).toHaveLength(2);
    expect(verdict.testResults[1]?.outputSummary).toContain('still-ran');
  });

  it('empty testCommands yields pass=true with no results (vacuous)', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith([]),
      { cwd: process.cwd(), now: () => NOW },
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.testResults).toEqual([]);
  });
});

describe('runExitCodeVerifier: verdict shape', () => {
  it('carries the runId from the run', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['true']),
      { cwd: process.cwd(), now: () => NOW },
    );
    expect(verdict.runId).toBe('run-1');
  });

  it('records each command with its exit code, duration, and output', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['echo hello']),
      { cwd: process.cwd(), now: () => NOW },
    );
    const tr = verdict.testResults[0]!;
    expect(tr.command).toBe('echo hello');
    expect(tr.exitCode).toBe(0);
    expect(tr.durationMs).toBeGreaterThanOrEqual(0);
    expect(tr.outputSummary).toContain('hello');
  });

  it('uses the provided now() for createdAt', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['true']),
      { cwd: process.cwd(), now: () => '2030-12-31T23:59:59.000Z' },
    );
    expect(verdict.createdAt).toBe('2030-12-31T23:59:59.000Z');
  });

  it('stubs semanticCheck with matches=true and a "not implemented" note', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['true']),
      { cwd: process.cwd(), now: () => NOW },
    );
    expect(verdict.semanticCheck.matches).toBe(true);
    expect(verdict.semanticCheck.reasoning.toLowerCase()).toContain(
      'not yet implemented',
    );
  });
});

describe('runExitCodeVerifier: cwd and timeouts', () => {
  it('runs commands in the given cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-verify-'));
    try {
      const verdict = await runExitCodeVerifier(
        sampleRun(),
        specWith(['pwd']),
        { cwd: dir, now: () => NOW },
      );
      // /tmp can be symlinked; just check the trailing path matches.
      expect(verdict.testResults[0]?.outputSummary.trim().endsWith(
        dir.split('/').slice(-1)[0]!,
      )).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks a hung command as a failure via the timeout', async () => {
    const verdict = await runExitCodeVerifier(
      sampleRun(),
      specWith(['sleep 5']),
      { cwd: process.cwd(), now: () => NOW, timeoutMsPerCommand: 100 },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.testResults[0]?.exitCode).toBe(-1);
    expect(verdict.testResults[0]?.outputSummary).toContain('[timed out]');
  });
});

describe('summarizeOutput', () => {
  it('returns combined output when small', () => {
    expect(summarizeOutput('hello\n', '')).toBe('hello\n');
  });

  it('includes a stderr section when stderr is non-empty', () => {
    const s = summarizeOutput('out\n', 'err\n');
    expect(s).toContain('out');
    expect(s).toContain('--- stderr ---');
    expect(s).toContain('err');
  });

  it('truncates oversized output to first/last 4KB with a marker', () => {
    const big = 'a'.repeat(20_000);
    const s = summarizeOutput(big, '');
    expect(s).toContain('[truncated]');
    expect(s.length).toBeLessThan(big.length);
    expect(s.startsWith('aaaa')).toBe(true);
    expect(s.endsWith('aaaa')).toBe(true);
  });

  it('prefixes with [timed out] when flagged', () => {
    expect(summarizeOutput('partial\n', '', { timedOut: true, spawnFailed: false }))
      .toContain('[timed out]');
  });

  it('prefixes with [spawn failed] when flagged', () => {
    expect(summarizeOutput('', 'err', { timedOut: false, spawnFailed: true }))
      .toContain('[spawn failed]');
  });
});
