import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  type Run,
  type Spec,
  type Plan,
  type Task,
  type Verdict,
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
} from '@agent-loop/core';
import { applyMigrations } from '../../src/db/migrate.js';
import { Store } from '../../src/db/store.js';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:01:00.000Z';

function newStore(): Store {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, () => NOW);
  return new Store(db);
}

function sampleRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    artifactDir: '/runs/run-1',
    branch: 'agent/run-1',
    phase: 'queued',
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
    ...overrides,
  };
}

function sampleSpec(runId: string = 'run-1'): Spec {
  return {
    id: SpecId(`spec-${runId}`),
    runId: RunId(runId),
    title: 'Add a passing test',
    description: 'Detailed description here.',
    fileScope: ['src/**/*.ts'],
    acceptanceCriteria: ['ac one', 'ac two'],
    testCommands: ['pnpm test'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  };
}

describe('Store: runs', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
  });

  it('inserts and retrieves a run', () => {
    const run = sampleRun();
    store.insertRun(run);
    expect(store.getRun(RunId('run-1'))).toEqual(run);
  });

  it('returns undefined for a missing run', () => {
    expect(store.getRun(RunId('nope'))).toBeUndefined();
  });

  it('round-trips a run with all optional fields populated', () => {
    const run = sampleRun({
      specId: SpecId('spec-1'),
      failure: {
        category: 'execution_error',
        message: 'agent crashed',
        phase: 'executing',
        artifactPath: '/runs/run-1/exec.log',
      },
      abandonedReason: 'user pressed STOP',
      prUrl: 'https://github.com/x/y/pull/9',
    });
    store.insertRun(run);
    expect(store.getRun(run.id)).toEqual(run);
  });

  it('round-trips a run with no optional fields (no undefined leakage)', () => {
    const run = sampleRun();
    store.insertRun(run);
    const back = store.getRun(run.id)!;
    expect('specId' in back).toBe(false);
    expect('failure' in back).toBe(false);
    expect('abandonedReason' in back).toBe(false);
    expect('prUrl' in back).toBe(false);
  });

  it('round-trips prUrl independently of other fields', () => {
    const run = sampleRun({ prUrl: 'https://example.test/pull/42' });
    store.insertRun(run);
    expect(store.getRun(run.id)?.prUrl).toBe('https://example.test/pull/42');
  });

  it('updateRunByVersion succeeds when versions match', () => {
    const run = sampleRun({ version: 0 });
    store.insertRun(run);
    const next: Run = { ...run, phase: 'triaging', version: 1, updatedAt: LATER };
    expect(store.updateRunByVersion(next, 0)).toBe(true);
    expect(store.getRun(run.id)?.phase).toBe('triaging');
    expect(store.getRun(run.id)?.version).toBe(1);
  });

  it('updateRunByVersion returns false when expected version is stale', () => {
    const run = sampleRun({ version: 0 });
    store.insertRun(run);
    // Writer A succeeds — advances version 0 -> 1 with phase change.
    store.updateRunByVersion(
      { ...run, phase: 'triaging', version: 1, updatedAt: LATER },
      0,
    );
    // Writer B still thinks the row is at version 0 — should be rejected.
    const stale: Run = { ...run, version: 1, phase: 'failed', updatedAt: LATER };
    expect(store.updateRunByVersion(stale, 0)).toBe(false);
    // Row reflects Writer A's update, not the stale write.
    expect(store.getRun(run.id)?.phase).toBe('triaging');
  });

  it('updateRunByVersion returns false when the row does not exist', () => {
    const run = sampleRun({ version: 1 });
    expect(store.updateRunByVersion(run, 0)).toBe(false);
  });

  it('listRuns returns all runs ordered by created_at', () => {
    store.insertRun(sampleRun({ id: RunId('a'), createdAt: NOW }));
    store.insertRun(sampleRun({ id: RunId('b'), createdAt: LATER }));
    const runs = store.listRuns();
    expect(runs.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('listRuns filters by a single phase', () => {
    store.insertRun(sampleRun({ id: RunId('a'), phase: 'queued' }));
    store.insertRun(sampleRun({ id: RunId('b'), phase: 'executing' }));
    const queued = store.listRuns({ phase: 'queued' });
    expect(queued.map((r) => r.id)).toEqual(['a']);
  });

  it('listRuns filters by an array of phases', () => {
    store.insertRun(sampleRun({ id: RunId('a'), phase: 'queued' }));
    store.insertRun(sampleRun({ id: RunId('b'), phase: 'executing' }));
    store.insertRun(sampleRun({ id: RunId('c'), phase: 'done' }));
    const active = store.listRuns({ phase: ['queued', 'executing'] });
    expect(active.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('listRuns with empty phase array returns []', () => {
    store.insertRun(sampleRun());
    expect(store.listRuns({ phase: [] })).toEqual([]);
  });
});

describe('Store: specs', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
    store.insertRun(sampleRun());
  });

  it('inserts and retrieves a spec by id and by run', () => {
    const spec = sampleSpec();
    store.insertSpec(spec);
    expect(store.getSpec(spec.id)).toEqual(spec);
    expect(store.getSpecByRun(spec.runId)).toEqual(spec);
  });

  it('round-trips JSON-encoded list/object fields', () => {
    const spec = sampleSpec();
    store.insertSpec(spec);
    const back = store.getSpec(spec.id)!;
    expect(back.fileScope).toEqual(['src/**/*.ts']);
    expect(back.acceptanceCriteria).toEqual(['ac one', 'ac two']);
    expect(back.budget).toEqual(DEFAULT_BUDGET);
  });

  it('enforces UNIQUE(run_id) — one spec per run', () => {
    store.insertSpec(sampleSpec());
    expect(() => store.insertSpec({ ...sampleSpec(), id: SpecId('spec-other') }))
      .toThrow(/UNIQUE/i);
  });

  it('round-trips fileStateChecks when present', () => {
    const spec = {
      ...sampleSpec(),
      fileStateChecks: [
        { type: 'unchanged' as const, path: 'src/foo.js' },
        { type: 'deleted' as const, path: 'src/old.js' },
        { type: 'exists' as const, path: 'src/new.js' },
        { type: 'absent' as const, path: 'src/never.js' },
      ],
    };
    store.insertSpec(spec);
    const back = store.getSpec(spec.id)!;
    expect(back.fileStateChecks).toEqual(spec.fileStateChecks);
  });

  it('omits fileStateChecks when absent (back-compat with pre-Option-E specs)', () => {
    const spec = sampleSpec(); // no fileStateChecks
    store.insertSpec(spec);
    const back = store.getSpec(spec.id)!;
    expect(back.fileStateChecks).toBeUndefined();
  });
});

describe('Store: plans', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
    store.insertRun(sampleRun());
    store.insertSpec(sampleSpec());
  });

  it('inserts and retrieves a plan by run', () => {
    const plan: Plan = {
      runId: RunId('run-1'),
      specId: SpecId('spec-run-1'),
      filesToTouch: [{ path: 'src/a.ts', action: 'create', reason: 'new feature' }],
      approach: 'do the thing',
      risks: ['might break X'],
      testStrategy: 'unit tests',
      createdAt: NOW,
    };
    store.insertPlan(plan);
    expect(store.getPlanByRun(plan.runId)).toEqual(plan);
  });

  it('schema enforces one plan per run (run_id is the PK)', () => {
    const plan: Plan = {
      runId: RunId('run-1'),
      specId: SpecId('spec-run-1'),
      filesToTouch: [],
      approach: 'a',
      risks: [],
      testStrategy: 't',
      createdAt: NOW,
    };
    store.insertPlan(plan);
    expect(() => store.insertPlan(plan)).toThrow(/PRIMARY KEY|UNIQUE/i);
  });
});

describe('Store: verdicts', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
    store.insertRun(sampleRun());
  });

  it('inserts and lists verdicts in chronological order', () => {
    const v1: Verdict = {
      runId: RunId('run-1'),
      pass: false,
      testResults: [
        { command: 'pnpm test', exitCode: 1, durationMs: 100, outputSummary: 'fail' },
      ],
      semanticCheck: { matches: false, reasoning: 'mismatch' },
      createdAt: NOW,
    };
    const v2: Verdict = { ...v1, pass: true, createdAt: LATER };

    store.insertVerdict(v1);
    store.insertVerdict(v2);

    const verdicts = store.listVerdicts(RunId('run-1'));
    expect(verdicts.length).toBe(2);
    expect(verdicts[0]?.pass).toBe(false);
    expect(verdicts[1]?.pass).toBe(true);
  });

  it('returns [] for a run with no verdicts', () => {
    expect(store.listVerdicts(RunId('run-1'))).toEqual([]);
  });

  it('round-trips the boolean pass field correctly (no leaky 0/1)', () => {
    const v: Verdict = {
      runId: RunId('run-1'),
      pass: true,
      testResults: [],
      semanticCheck: { matches: true, reasoning: 'ok' },
      createdAt: NOW,
    };
    store.insertVerdict(v);
    const back = store.listVerdicts(RunId('run-1'))[0]!;
    expect(back.pass).toBe(true);
    expect(typeof back.pass).toBe('boolean');
  });

  it('round-trips semanticCheck.perCriterion when present', () => {
    const v: Verdict = {
      runId: RunId('run-1'),
      pass: true,
      testResults: [],
      semanticCheck: {
        matches: true,
        reasoning: 'all met',
        perCriterion: [
          { criterion: 'foo is bar', met: true, reasoning: 'ev1' },
          { criterion: 'baz is qux', met: true, reasoning: 'ev2' },
        ],
      },
      createdAt: NOW,
    };
    store.insertVerdict(v);
    const back = store.listVerdicts(RunId('run-1'))[0]!;
    expect(back.semanticCheck.perCriterion).toHaveLength(2);
    expect(back.semanticCheck.perCriterion?.[0]?.criterion).toBe('foo is bar');
  });

  it('omits semanticCheck.perCriterion when absent (back-compat with old rows)', () => {
    const v: Verdict = {
      runId: RunId('run-1'),
      pass: true,
      testResults: [],
      semanticCheck: { matches: true, reasoning: 'ok' },
      createdAt: NOW,
    };
    store.insertVerdict(v);
    const back = store.listVerdicts(RunId('run-1'))[0]!;
    expect(back.semanticCheck.perCriterion).toBeUndefined();
  });

});

describe('Store: events', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
    store.insertRun(sampleRun());
  });

  it('inserts and lists events for a run', () => {
    store.insertEvent(RunId('run-1'), { type: 'start_triage' }, 1, NOW);
    store.insertEvent(
      RunId('run-1'),
      { type: 'triage_succeeded', specId: SpecId('spec-1') },
      2,
      LATER,
    );

    const events = store.listEvents(RunId('run-1'));
    expect(events.length).toBe(2);
    expect(events[0]?.event.type).toBe('start_triage');
    expect(events[1]?.event.type).toBe('triage_succeeded');
    expect(events[1]?.runVersionAfter).toBe(2);
  });

  it('preserves the full event payload through JSON round-trip', () => {
    const event = {
      type: 'execution_failed',
      failure: { category: 'execution_error', message: 'boom' },
    } as const;
    store.insertEvent(RunId('run-1'), event, 1, NOW);
    const back = store.listEvents(RunId('run-1'))[0]!;
    expect(back.event).toEqual(event);
  });

  it('rejects events for nonexistent runs via FK', () => {
    expect(() =>
      store.insertEvent(RunId('ghost'), { type: 'start_triage' }, 1, NOW),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('Store: tasks', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
  });

  it('round-trips a minimal Task', () => {
    const task: Task = {
      id: TaskId('local:hardcoded'),
      title: 'hardcoded task',
      body: 'body',
      source: 'local',
      createdAt: NOW,
    };
    store.insertTask(task);
    expect(store.getTask(task.id)).toEqual(task);
  });

  it('returns undefined for a missing task', () => {
    expect(store.getTask(TaskId('missing'))).toBeUndefined();
  });

  it('round-trips a Task with url and sourceMetadata populated', () => {
    const task: Task = {
      id: TaskId('github:foo/bar#42'),
      title: 'an issue',
      body: 'issue body',
      source: 'github:foo/bar',
      createdAt: NOW,
      url: 'https://github.com/foo/bar/issues/42',
      sourceMetadata: {
        labels: ['bug', 'agent-ready'],
        assignees: ['alice'],
      },
    };
    store.insertTask(task);
    expect(store.getTask(task.id)).toEqual(task);
  });

  it('omits url and sourceMetadata when absent (no undefined leakage)', () => {
    const task: Task = {
      id: TaskId('x'),
      title: 't',
      body: 'b',
      source: 'local',
      createdAt: NOW,
    };
    store.insertTask(task);
    const back = store.getTask(task.id)!;
    expect('url' in back).toBe(false);
    expect('sourceMetadata' in back).toBe(false);
  });

  it('listTasksBySource filters by source and orders by created_at', () => {
    store.insertTask({
      id: TaskId('github:a/b#1'),
      title: 't1', body: 'b1', source: 'github:a/b',
      createdAt: '2026-05-23T10:00:00.000Z',
    });
    store.insertTask({
      id: TaskId('local:x'),
      title: 't2', body: 'b2', source: 'local',
      createdAt: '2026-05-23T09:00:00.000Z',
    });
    store.insertTask({
      id: TaskId('github:a/b#2'),
      title: 't3', body: 'b3', source: 'github:a/b',
      createdAt: '2026-05-23T11:00:00.000Z',
    });
    const ghTasks = store.listTasksBySource('github:a/b');
    expect(ghTasks.map((t) => t.id)).toEqual([
      'github:a/b#1',
      'github:a/b#2',
    ]);
  });

  it('enforces PRIMARY KEY on id', () => {
    const task: Task = {
      id: TaskId('dup'),
      title: 't', body: 'b', source: 'local',
      createdAt: NOW,
    };
    store.insertTask(task);
    expect(() => store.insertTask(task)).toThrow(/UNIQUE|PRIMARY KEY/i);
  });
});

describe('Store: transactions', () => {
  it('commits when the callback returns', () => {
    const store = newStore();
    store.transaction(() => {
      store.insertRun(sampleRun({ id: RunId('a') }));
      store.insertRun(sampleRun({ id: RunId('b') }));
    });
    expect(store.listRuns().map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('rolls back when the callback throws', () => {
    const store = newStore();
    expect(() =>
      store.transaction(() => {
        store.insertRun(sampleRun({ id: RunId('a') }));
        throw new Error('rollback me');
      }),
    ).toThrow('rollback me');
    expect(store.listRuns()).toEqual([]);
  });

  it('returns the callback result', () => {
    const store = newStore();
    const result = store.transaction(() => 42);
    expect(result).toBe(42);
  });
});
