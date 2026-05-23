/**
 * gc command tests. The execution path (worktree removal, branch deletion)
 * is exercised via injectable git runners — no real git invoked. The
 * plan-building path (which runs are eligible, in what order) is tested
 * against a real in-memory Store.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunId,
  TaskId,
  type Run,
  type Phase,
} from '@agent-loop/core';
import { openDb } from '@agent-loop/runtime';
import {
  gc,
  buildGcPlan,
  selectEligibleRuns,
  __setGcExecutionDeps,
} from '../src/commands/gc.js';
import { resolvePaths } from '../src/config.js';

let home: string;
let stdout: string[];
let stderr: string[];
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-loop-gc-'));
  process.env['AGENT_LOOP_HOME'] = home;
  stdout = [];
  stderr = [];
  origOut = process.stdout.write.bind(process.stdout);
  origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    stdout.push(typeof s === 'string' ? s : s.toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    stderr.push(typeof s === 'string' ? s : s.toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  delete process.env['AGENT_LOOP_HOME'];
  __setGcExecutionDeps({});
  rmSync(home, { recursive: true, force: true });
});

function out(): string {
  return stdout.join('');
}
function err(): string {
  return stderr.join('');
}

function seedRun(
  phase: Phase,
  idSuffix: string,
  updatedAt: string,
): Run {
  const store = openDb(join(home, 'runs.db'));
  const run: Run = {
    id: RunId(`run-${idSuffix}`),
    taskId: TaskId('task-1'),
    artifactDir: `/runs/run-${idSuffix}`,
    branch: `agent/run-${idSuffix}`,
    phase,
    version: 0,
    createdAt: updatedAt,
    updatedAt,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  };
  store.insertRun(run);
  return run;
}

const NOW = new Date('2026-05-23T18:00:00.000Z');
const TEN_DAYS_AGO = '2026-05-13T18:00:00.000Z';
const ONE_DAY_AGO = '2026-05-22T18:00:00.000Z';

// --- Plan building --------------------------------------------------------

describe('selectEligibleRuns', () => {
  it('returns terminal runs older than ageDays', () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    seedRun('done', 'recent', ONE_DAY_AGO);
    const store = openDb(join(home, 'runs.db'));
    const eligible = selectEligibleRuns(store, { ageDays: 7 }, NOW);
    expect(eligible.map((r) => r.id).sort()).toEqual(['run-old']);
  });

  it('ignores non-terminal runs even when older than ageDays', () => {
    seedRun('executing', 'still-running', TEN_DAYS_AGO);
    const store = openDb(join(home, 'runs.db'));
    expect(selectEligibleRuns(store, { ageDays: 7 }, NOW)).toEqual([]);
  });

  it('includes failed and abandoned terminal runs (not just done)', () => {
    seedRun('done', 'a', TEN_DAYS_AGO);
    seedRun('failed', 'b', TEN_DAYS_AGO);
    seedRun('abandoned', 'c', TEN_DAYS_AGO);
    const store = openDb(join(home, 'runs.db'));
    const eligible = selectEligibleRuns(store, { ageDays: 7 }, NOW);
    expect(eligible.map((r) => r.id).sort()).toEqual(['run-a', 'run-b', 'run-c']);
  });

  it('--run targets a single run only when it is terminal', () => {
    seedRun('executing', 'live', TEN_DAYS_AGO);
    seedRun('done', 'old', TEN_DAYS_AGO);
    const store = openDb(join(home, 'runs.db'));
    expect(selectEligibleRuns(store, { run: 'run-live' }, NOW)).toEqual([]);
    const eligible = selectEligibleRuns(store, { run: 'run-old' }, NOW);
    expect(eligible.map((r) => r.id)).toEqual(['run-old']);
  });

  it('--run for an unknown id returns empty', () => {
    const store = openDb(join(home, 'runs.db'));
    expect(selectEligibleRuns(store, { run: 'run-ghost' }, NOW)).toEqual([]);
  });
});

describe('buildGcPlan', () => {
  it('emits removeWorktree + deleteLocalBranch by default', () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    const paths = resolvePaths();
    mkdirSync(join(paths.worktreesDir, 'run-old', 'worktree'), { recursive: true });
    const store = openDb(join(home, 'runs.db'));
    const plan = buildGcPlan(store, paths, { ageDays: 7 }, NOW);
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'removeWorktree',
      'deleteLocalBranch',
    ]);
  });

  it('appends deleteRemoteBranch when --remote is set', () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    const paths = resolvePaths();
    mkdirSync(join(paths.worktreesDir, 'run-old', 'worktree'), { recursive: true });
    const store = openDb(join(home, 'runs.db'));
    const plan = buildGcPlan(store, paths, { ageDays: 7, remote: true }, NOW);
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'removeWorktree',
      'deleteLocalBranch',
      'deleteRemoteBranch',
    ]);
  });

  it('skips removeWorktree when the worktree dir does not exist', () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    // no worktree dir created
    const paths = resolvePaths();
    const store = openDb(join(home, 'runs.db'));
    const plan = buildGcPlan(store, paths, { ageDays: 7 }, NOW);
    expect(plan.actions.map((a) => a.kind)).toEqual(['deleteLocalBranch']);
  });
});

// --- Execution path -------------------------------------------------------

describe('gc command (execution)', () => {
  it('--dry-run prints the plan and exits 0 without invoking git', async () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    let invoked = false;
    __setGcExecutionDeps({
      removeWorktreeFn: async () => {
        invoked = true;
      },
      deleteLocalBranchFn: async () => {
        invoked = true;
        return fakeOkResult();
      },
    });
    const code = await gc({ ageDays: 7, dryRun: true });
    expect(code).toBe(0);
    expect(out()).toContain('1 eligible run(s)');
    expect(out()).toContain('dry-run');
    expect(invoked).toBe(false);
  });

  it('reports "no terminal runs older than N day(s)" on empty plan', async () => {
    const code = await gc({ ageDays: 7 });
    expect(code).toBe(0);
    expect(out()).toContain('no terminal runs');
  });

  it('default run executes removeWorktree + deleteLocalBranch and writes gc.log', async () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    const paths = resolvePaths();
    mkdirSync(join(paths.worktreesDir, 'run-old', 'worktree'), { recursive: true });
    const calls: string[] = [];
    __setGcExecutionDeps({
      removeWorktreeFn: async () => {
        calls.push('rmWt');
      },
      deleteLocalBranchFn: async () => {
        calls.push('rmBr');
        return fakeOkResult();
      },
      now: () => '2026-05-23T18:00:00.000Z',
    });
    const code = await gc({ ageDays: 7 });
    expect(code).toBe(0);
    expect(calls).toEqual(['rmWt', 'rmBr']);
    // gc.log is JSONL: two lines for two actions.
    const log = readFileSync(join(home, 'gc.log'), 'utf8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.action).toBe('removeWorktree');
    expect(first.ok).toBe(true);
    expect(first.runId).toBe('run-old');
  });

  it('records a failed action in gc.log with ok=false and the error', async () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    const paths = resolvePaths();
    mkdirSync(join(paths.worktreesDir, 'run-old', 'worktree'), { recursive: true });
    __setGcExecutionDeps({
      removeWorktreeFn: async () => {
        throw new Error('boom');
      },
      deleteLocalBranchFn: async () => fakeOkResult(),
    });
    const code = await gc({ ageDays: 7 });
    expect(code).toBe(1); // at least one action failed
    const log = readFileSync(join(home, 'gc.log'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    const wtLine = lines.find((l) => l.action === 'removeWorktree');
    expect(wtLine.ok).toBe(false);
    expect(wtLine.error).toContain('boom');
    expect(err()).toContain('FAIL');
  });

  it('--remote with --yes invokes the remote-delete path (no prompt)', async () => {
    seedRun('done', 'old', TEN_DAYS_AGO);
    const paths = resolvePaths();
    mkdirSync(join(paths.worktreesDir, 'run-old', 'worktree'), { recursive: true });
    const calls: string[] = [];
    __setGcExecutionDeps({
      removeWorktreeFn: async () => {
        calls.push('rmWt');
      },
      deleteLocalBranchFn: async () => {
        calls.push('rmBr');
        return fakeOkResult();
      },
      deleteRemoteBranchFn: async () => {
        calls.push('rmRem');
        return fakeOkResult();
      },
    });
    const code = await gc({ ageDays: 7, remote: true, yes: true });
    expect(code).toBe(0);
    expect(calls).toEqual(['rmWt', 'rmBr', 'rmRem']);
  });

  it('--run targets a single run (still subject to terminal check)', async () => {
    seedRun('done', 'wanted', TEN_DAYS_AGO);
    seedRun('done', 'other', TEN_DAYS_AGO);
    const paths = resolvePaths();
    mkdirSync(join(paths.worktreesDir, 'run-wanted', 'worktree'), { recursive: true });
    const handled: string[] = [];
    __setGcExecutionDeps({
      removeWorktreeFn: async (_repo, p) => {
        handled.push(p);
      },
      deleteLocalBranchFn: async (_repo, branch) => {
        handled.push(branch);
        return fakeOkResult();
      },
    });
    const code = await gc({ run: 'run-wanted' });
    expect(code).toBe(0);
    // Only the targeted run's actions ran.
    expect(handled.some((s) => s.includes('run-wanted'))).toBe(true);
    expect(handled.some((s) => s.includes('run-other'))).toBe(false);
  });

  it('--run on an unknown id prints "not found" and exits 0', async () => {
    const code = await gc({ run: 'run-nope' });
    expect(code).toBe(0);
    expect(out()).toContain('not found');
  });
});

function fakeOkResult(): import('@agent-loop/runtime').RunCommandResult {
  return {
    command: 'git',
    args: [],
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  };
}
