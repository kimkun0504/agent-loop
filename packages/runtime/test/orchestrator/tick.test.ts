/**
 * tick() integration tests. We use a real git fixture repo for worktree
 * creation, an in-memory SQLite Store, and stubs for the agent/verifier/PR
 * dependencies.
 */

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { execa } from 'execa';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  type Run,
  type Spec,
  type Verdict,
  type Logger,
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
  Logger as CoreLogger,
} from '@agent-loop/core';
import { applyMigrations } from '../../src/db/migrate.js';
import { Store } from '../../src/db/store.js';
import { tick, type Deps, type Verifier } from '../../src/orchestrator/tick.js';
import type { Executor } from '../../src/executor/types.js';
import type { PrOpener, PrOpenResult } from '../../src/pr/types.js';

const NOW = '2026-01-01T00:00:00.000Z';
const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

let tmpRoot: string;
let repoDir: string;
let workspaceDir: string;
let worktreesDir: string;
let artifactsDir: string;
let runCounter = 0;

const silentLogger: Logger = new CoreLogger({ level: 'error', console: false });

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agent-loop-tick-'));
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

function freshRunId(): string {
  runCounter += 1;
  return `run-${runCounter}`;
}

function freshStore(): Store {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, () => NOW);
  return new Store(db);
}

function seedRunAndSpec(
  store: Store,
  phase: Run['phase'],
  overrides: Partial<Run> = {},
): { run: Run; spec: Spec } {
  const id = freshRunId();
  const run: Run = {
    id: RunId(id),
    taskId: TaskId('task-1'),
    artifactDir: join(artifactsDir, id),
    branch: `agent/${id}`,
    phase,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
    ...overrides,
  };
  store.insertRun(run);
  const spec: Spec = {
    id: SpecId(`spec-${id}`),
    runId: run.id,
    title: 'title',
    description: 'description',
    fileScope: ['**/*'],
    acceptanceCriteria: ['ac'],
    testCommands: ['true'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  };
  store.insertSpec(spec);
  return { run, spec };
}

const stubExecutor = (
  result: Awaited<ReturnType<Executor['execute']>>,
): Executor => ({
  execute: async () => result,
});

/**
 * Stub executor that writes a file into the worktree (so the post-executor
 * commit has something to stage) and returns ok=true. Mirrors the realistic
 * happy path — the real ClaudeCliExecutor leaves edited files behind.
 */
const stubExecutorThatEditsFile = (
  filename: string,
  content: string,
): Executor => ({
  execute: async (input) => {
    writeFileSync(join(input.worktreePath, filename), content);
    return {
      ok: true,
      exitCode: 0,
      durationMs: 1,
      outputLog: '',
      timedOut: false,
      spawnFailed: false,
    };
  },
});

const stubVerifier =
  (verdict: Omit<Verdict, 'runId'>): Verifier =>
  async (run) => ({ ...verdict, runId: run.id });

const stubPrOpener = (result: PrOpenResult): PrOpener => ({
  openPullRequest: async () => result,
});

function makeDeps(
  store: Store,
  overrides: Partial<Deps> = {},
): Deps {
  return {
    store,
    logger: silentLogger,
    workspaceDir,
    worktreesDir,
    artifactsDir,
    repoDir,
    now: () => NOW,
    // Default success path: write a file in the worktree so the
    // post-executor commit has something to stage.
    executor: stubExecutorThatEditsFile('NOTES.md', 'agent was here\n'),
    verifier: stubVerifier({
      pass: true,
      testResults: [],
      semanticCheck: { matches: true, reasoning: 'stub' },
      createdAt: NOW,
    }),
    prOpener: stubPrOpener({ ok: true, url: 'https://github.com/x/y/pull/1' }),
    ...overrides,
  };
}

describe('tick: no-op phases', () => {
  it('returns the run unchanged on terminal phase done', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'done');
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('done');
    expect(after.version).toBe(0);
  });

  it('returns the run unchanged on terminal phase failed', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'failed');
    const after = await tick(makeDeps(store), run);
    expect(after).toBe(run);
  });

  it('is a no-op on queued (CLI-driven in week 2)', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'queued');
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('queued');
    expect(after.version).toBe(0);
  });

  it('is a no-op on triaging', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'triaging');
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('triaging');
  });
});

describe('tick: STOP file', () => {
  it('returns immediately when STOP is present (no executor call)', async () => {
    const stopRoot = mkdtempSync(join(tmpdir(), 'agent-loop-stop-tick-'));
    try {
      writeFileSync(join(stopRoot, 'STOP'), '');
      const store = freshStore();
      const { run } = seedRunAndSpec(store, 'executing');
      let executorCalled = false;
      const deps = makeDeps(store, {
        workspaceDir: stopRoot,
        executor: {
          execute: async () => {
            executorCalled = true;
            return {
              ok: true,
              exitCode: 0,
              durationMs: 1,
              outputLog: '',
              timedOut: false,
              spawnFailed: false,
            };
          },
        },
      });
      const after = await tick(deps, run);
      expect(executorCalled).toBe(false);
      expect(after.phase).toBe('executing');
      expect(after.version).toBe(0);
    } finally {
      rmSync(stopRoot, { recursive: true, force: true });
    }
  });
});

describe('tick: executing phase', () => {
  it('creates the worktree, invokes the executor, applies execution_succeeded', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('verifying');
    expect(after.version).toBe(1);

    const worktreePath = join(worktreesDir, run.id, 'worktree');
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
  });

  it('lazy-creates the artifact directory', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    await tick(makeDeps(store), run);
    expect(existsSync(join(artifactsDir, run.id))).toBe(true);
  });

  it('records execution_succeeded as an event', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    await tick(makeDeps(store), run);
    const events = store.listEvents(run.id);
    expect(events.at(-1)?.event.type).toBe('execution_succeeded');
  });

  it('applies execution_failed with category=execution_error when executor returns ok=false', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    const deps = makeDeps(store, {
      executor: stubExecutor({
        ok: false,
        exitCode: 1,
        durationMs: 1,
        outputLog: '',
        timedOut: false,
        spawnFailed: false,
      }),
    });
    const after = await tick(deps, run);
    expect(after.phase).toBe('failed');
    expect(after.failure?.category).toBe('execution_error');
  });

  it('applies execution_failed with category=budget_exceeded on timeout', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    const deps = makeDeps(store, {
      executor: stubExecutor({
        ok: false,
        exitCode: -1,
        durationMs: 5000,
        outputLog: '',
        timedOut: true,
        spawnFailed: false,
      }),
    });
    const after = await tick(deps, run);
    expect(after.failure?.category).toBe('budget_exceeded');
    expect(after.failure?.message).toContain('timed out');
  });

  it('applies execution_failed with category=internal when no spec exists', async () => {
    const store = freshStore();
    const id = freshRunId();
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
    // no spec inserted
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('failed');
    expect(after.failure?.category).toBe('internal');
  });

  it('reuses an existing worktree on re-entry to executing', async () => {
    // Simulate the realistic crash-recovery scenario: a prior tick created
    // the worktree but the orchestrator died before applying
    // execution_succeeded. On restart the run is still in `executing` and
    // the worktree dir already exists. tick must not throw.
    const { addWorktree } = await import('../../src/git/worktree.js');
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    const wtPath = join(worktreesDir, run.id, 'worktree');
    await addWorktree(repoDir, run.branch, wtPath);

    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('verifying');
    expect(existsSync(wtPath)).toBe(true);
  });

  it('fails with execution_error when executor returns ok=true but produces no file changes', async () => {
    // The executor "succeeded" but didn't edit anything. The commit step
    // should fail loudly — an empty PR is not a success.
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    const deps = makeDeps(store, {
      executor: stubExecutor({
        ok: true,
        exitCode: 0,
        durationMs: 1,
        outputLog: '',
        timedOut: false,
        spawnFailed: false,
      }),
    });
    const after = await tick(deps, run);
    expect(after.phase).toBe('failed');
    expect(after.failure?.category).toBe('execution_error');
    expect(after.failure?.message).toMatch(/no file changes|nothing to commit/);
  });

  it('commits agent changes after a successful executor run', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    await tick(makeDeps(store), run);

    // The worktree should now have a commit beyond the fixture's init.
    const wtPath = join(worktreesDir, run.id, 'worktree');
    const log = await execa('git', ['log', '--oneline'], { cwd: wtPath });
    const lines = log.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // The agent-loop commit message contains the spec title.
    expect(log.stdout).toContain('title');
  });

  it('records token usage and time spent when executor returns usage', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    const deps = makeDeps(store, {
      executor: {
        execute: async (input) => {
          // Side-effect: create a file so the commit step succeeds.
          writeFileSync(join(input.worktreePath, 'NOTES.md'), 'agent was here\n');
          return {
            ok: true,
            exitCode: 0,
            durationMs: 2500,
            outputLog: '',
            timedOut: false,
            spawnFailed: false,
            usage: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadInputTokens: 30,
              cacheCreationInputTokens: 4,
              costUsd: 0.012,
            },
          };
        },
      },
    });
    const after = await tick(deps, run);
    expect(after.phase).toBe('verifying');
    // 1000 + 200 + 30 + 4
    expect(after.tokensSpent).toBe(1234);
    // 2500ms -> 3 seconds (rounded)
    expect(after.secondsSpent).toBe(3);

    const events = store.listEvents(run.id);
    const tokenEvent = events.find((e) => e.event.type === 'record_token_usage');
    expect(tokenEvent).toBeDefined();
    if (tokenEvent?.event.type === 'record_token_usage') {
      expect(tokenEvent.event.tokens).toBe(1234);
      expect(tokenEvent.event.usage?.costUsd).toBeCloseTo(0.012);
      expect(tokenEvent.event.usage?.cacheReadInputTokens).toBe(30);
    }
  });

  it('records usage even when the executor failed (failures still cost tokens)', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'executing');
    const deps = makeDeps(store, {
      executor: {
        execute: async () => ({
          ok: false,
          exitCode: 1,
          durationMs: 100,
          outputLog: '',
          timedOut: false,
          spawnFailed: false,
          usage: { inputTokens: 500, outputTokens: 5 },
        }),
      },
    });
    const after = await tick(deps, run);
    // Should still land in failed (executor.ok=false), but tokens recorded.
    expect(after.phase).toBe('failed');
    expect(after.tokensSpent).toBe(505);
  });
});

describe('tick: verifying phase', () => {
  it('runs the verifier, persists the verdict, applies verification_succeeded on pass', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'verifying');
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('opening_pr');

    const verdicts = store.listVerdicts(run.id);
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]?.pass).toBe(true);
  });

  it('applies verification_failed with category=verification_failed on a failing verdict', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'verifying');
    const deps = makeDeps(store, {
      verifier: stubVerifier({
        pass: false,
        testResults: [
          {
            command: 'pnpm test',
            exitCode: 1,
            durationMs: 10,
            outputSummary: 'fail',
          },
        ],
        semanticCheck: { matches: false, reasoning: 'no' },
        createdAt: NOW,
      }),
    });
    const after = await tick(deps, run);
    expect(after.phase).toBe('failed');
    expect(after.failure?.category).toBe('verification_failed');
    // The failing verdict is still recorded.
    expect(store.listVerdicts(run.id)).toHaveLength(1);
    expect(store.listVerdicts(run.id)[0]?.pass).toBe(false);
  });

  it('handles missing-spec defensively', async () => {
    const store = freshStore();
    const id = freshRunId();
    const run: Run = {
      id: RunId(id),
      taskId: TaskId('task-1'),
      artifactDir: join(artifactsDir, id),
      branch: `agent/${id}`,
      phase: 'verifying',
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
      attemptCount: 0,
      tokensSpent: 0,
      secondsSpent: 0,
    };
    store.insertRun(run);
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('failed');
    expect(after.failure?.category).toBe('internal');
  });
});

describe('tick: opening_pr phase', () => {
  it('opens the PR and applies pr_opened on success', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'opening_pr');
    // Need a passing verdict in the store for opening_pr to proceed.
    store.insertVerdict({
      runId: run.id,
      pass: true,
      testResults: [],
      semanticCheck: { matches: true, reasoning: 'ok' },
      createdAt: NOW,
    });
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('done');
  });

  it('applies pr_failed when the opener fails', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'opening_pr');
    store.insertVerdict({
      runId: run.id,
      pass: true,
      testResults: [],
      semanticCheck: { matches: true, reasoning: 'ok' },
      createdAt: NOW,
    });
    const deps = makeDeps(store, {
      prOpener: stubPrOpener({ ok: false, error: 'remote rejected' }),
    });
    const after = await tick(deps, run);
    expect(after.phase).toBe('failed');
    expect(after.failure?.category).toBe('internal');
    expect(after.failure?.message).toContain('remote rejected');
  });

  it('refuses to open a PR when no passing verdict exists', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'opening_pr');
    // No verdict inserted.
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('failed');
    expect(after.failure?.message).toContain('no passing verdict');
  });

  it('refuses to open a PR when the latest verdict is failing', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'opening_pr');
    store.insertVerdict({
      runId: run.id,
      pass: false,
      testResults: [],
      semanticCheck: { matches: false, reasoning: 'no' },
      createdAt: NOW,
    });
    const after = await tick(makeDeps(store), run);
    expect(after.phase).toBe('failed');
  });

  it('passes the latest passing verdict to the PR opener', async () => {
    const store = freshStore();
    const { run } = seedRunAndSpec(store, 'opening_pr');
    store.insertVerdict({
      runId: run.id,
      pass: true,
      testResults: [
        {
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 100,
          outputSummary: 'ok',
        },
      ],
      semanticCheck: { matches: true, reasoning: 'good' },
      createdAt: NOW,
    });
    let receivedVerdict: Verdict | undefined;
    const deps = makeDeps(store, {
      prOpener: {
        openPullRequest: async (input) => {
          receivedVerdict = input.verdict;
          return { ok: true, url: 'https://github.com/x/y/pull/2' };
        },
      },
    });
    await tick(deps, run);
    expect(receivedVerdict?.pass).toBe(true);
    expect(receivedVerdict?.testResults).toHaveLength(1);
  });
});
