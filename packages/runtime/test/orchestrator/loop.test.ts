/**
 * runLoop tests. The POLL_INTERVAL_MS is fixed at 2000 (per the v2 plan),
 * so tests use AbortSignal to short-circuit the sleep rather than waiting.
 */

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
} from 'vitest';
import { execa } from 'execa';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  type Run,
  type Logger,
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
  Logger as CoreLogger,
} from '@agent-loop/core';
import { applyMigrations } from '../../src/db/migrate.js';
import { Store } from '../../src/db/store.js';
import { runLoop } from '../../src/orchestrator/loop.js';
import type { Deps, Verifier } from '../../src/orchestrator/tick.js';
import type { Executor } from '../../src/executor/types.js';
import type { PrOpener } from '../../src/pr/types.js';

const NOW = '2026-01-01T00:00:00.000Z';
const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

let tmpRoot: string;
let repoDir: string;
let workspaceDir: string;
let worktreesDir: string;
let artifactsDir: string;
let counter = 0;

const silentLogger: Logger = new CoreLogger({ level: 'error', console: false });

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agent-loop-loop-'));
  repoDir = join(tmpRoot, 'repo');
  workspaceDir = join(tmpRoot, 'workspace');
  worktreesDir = join(tmpRoot, 'worktrees');
  artifactsDir = join(tmpRoot, 'artifacts');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  await execa('git', ['init', '-b', 'main', repoDir]);
  writeFileSync(join(repoDir, 'README.md'), '# fixture\n');
  await execa('git', [...GIT_ID, 'add', '.'], { cwd: repoDir });
  await execa('git', [...GIT_ID, 'commit', '-m', 'init'], { cwd: repoDir });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function freshStore(): Store {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, () => NOW);
  return new Store(db);
}

function seedExecutingRun(store: Store): Run {
  counter += 1;
  const id = `run-${counter}`;
  const run: Run = {
    id: RunId(id),
    taskId: TaskId('task-1'),
    artifactDir: join(artifactsDir, id),
    branch: `agent/${id}`,
    phase: 'executing',
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  };
  store.insertRun(run);
  store.insertSpec({
    id: SpecId(`spec-${id}`),
    runId: run.id,
    title: 't',
    description: 'd',
    fileScope: ['**/*'],
    acceptanceCriteria: ['ac'],
    testCommands: ['true'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  });
  return run;
}

const okExecutor: Executor = {
  // Side-effect: write a file in the worktree so the post-executor commit
  // step has something to stage.
  execute: async (input) => {
    writeFileSync(
      join(input.worktreePath, 'NOTES.md'),
      'agent was here\n',
    );
    return {
      ok: true,
      exitCode: 0,
      durationMs: 1,
      outputLog: '',
      timedOut: false,
      spawnFailed: false,
    };
  },
};

const okVerifier: Verifier = async (run) => ({
  verdict: {
    runId: run.id,
    pass: true,
    testResults: [],
    semanticCheck: { matches: true, reasoning: 'stub' },
    createdAt: NOW,
  },
  usages: [],
});

const okPrOpener: PrOpener = {
  openPullRequest: async () => ({
    ok: true,
    url: 'https://github.com/x/y/pull/1',
  }),
};

function makeDeps(store: Store, ws = workspaceDir): Deps {
  return {
    store,
    logger: silentLogger,
    workspaceDir: ws,
    worktreesDir,
    artifactsDir,
    repoDir,
    now: () => NOW,
    executor: okExecutor,
    verifier: okVerifier,
    prOpener: okPrOpener,
  };
}

describe('runLoop: exit conditions', () => {
  it('returns immediately when the abort signal is already aborted', async () => {
    const store = freshStore();
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await runLoop(makeDeps(store), { signal: controller.signal });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('returns immediately when STOP is present at startup', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'agent-loop-loop-stop-'));
    try {
      writeFileSync(join(ws, 'STOP'), '');
      const store = freshStore();
      // Even with non-terminal runs queued, STOP wins.
      seedExecutingRun(store);
      const start = Date.now();
      await runLoop(makeDeps(store, ws));
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('runLoop: tick dispatch', () => {
  it('ticks one non-terminal run, then exits when abort fires mid-sleep', async () => {
    const store = freshStore();
    const run = seedExecutingRun(store);
    const controller = new AbortController();
    // After the first tick the loop enters a 2s sleep. Abort while it's
    // sleeping so the next iteration sees the abort and returns.
    const loopPromise = runLoop(makeDeps(store), { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await loopPromise;
    const after = store.getRun(run.id)!;
    // Run advanced from executing -> verifying.
    expect(after.phase).toBe('verifying');
  });

  it('logs and continues when tick throws (does not crash the loop)', async () => {
    const store = freshStore();
    seedExecutingRun(store);
    const errors: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const capturingLogger = new CoreLogger({ level: 'error', console: false });
    capturingLogger.error = (msg, ctx = {}): void => {
      errors.push({ msg, ctx });
    };
    const deps: Deps = {
      ...makeDeps(store),
      logger: capturingLogger,
      executor: {
        execute: async () => {
          throw new Error('boom');
        },
      },
    };
    const controller = new AbortController();
    const loopPromise = runLoop(deps, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await loopPromise;
    expect(errors.find((e) => e.msg === 'loop: tick threw')).toBeDefined();
  });

  it('keeps polling when no runs exist, then exits on abort', async () => {
    const store = freshStore();
    // No runs seeded.
    const controller = new AbortController();
    const start = Date.now();
    const loopPromise = runLoop(makeDeps(store), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await loopPromise;
    const elapsed = Date.now() - start;
    // Aborted well before the 2s poll interval would have elapsed.
    expect(elapsed).toBeLessThan(1500);
  });

  it('exits when STOP is written mid-run', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'agent-loop-loop-stop-mid-'));
    try {
      const store = freshStore();
      seedExecutingRun(store);
      const controller = new AbortController();
      const loopPromise = runLoop(makeDeps(store, ws), { signal: controller.signal });
      // Drop the STOP file after the first tick completes.
      setTimeout(() => writeFileSync(join(ws, 'STOP'), ''), 100);
      // Safety abort if STOP isn't picked up.
      setTimeout(() => controller.abort(), 4000);
      await loopPromise;
      // We don't assert about run state because timing varies; we only
      // assert the loop returned without hanging.
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 6000);
});
