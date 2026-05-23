import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  RunId,
  TaskId,
  SpecId,
  DEFAULT_BUDGET,
  InvalidTransitionError,
  type Run,
  type Spec,
} from '@agent-loop/core';
import { applyMigrations, Store } from '@agent-loop/runtime';
import { driveToExecuting } from '../src/drive.js';

const NOW = '2026-05-23T15:00:00.000Z';

function freshStore(): Store {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, () => NOW);
  return new Store(db);
}

function seedQueuedRun(store: Store): Run {
  const run: Run = {
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
  };
  store.insertRun(run);
  return run;
}

function buildTestSpec(): Spec {
  return {
    id: SpecId('spec-run-1'),
    runId: RunId('run-1'),
    title: 'Test spec',
    description: 'A test spec',
    fileScope: ['src/**/*'],
    acceptanceCriteria: ['ac'],
    testCommands: ['true'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  };
}

describe('driveToExecuting', () => {
  it('walks a queued run to executing', () => {
    const store = freshStore();
    seedQueuedRun(store);
    const run = driveToExecuting({
      store,
      spec: buildTestSpec(),
      now: () => NOW,
    });
    expect(run.phase).toBe('executing');
  });

  it('persists the spec to the store', () => {
    const store = freshStore();
    seedQueuedRun(store);
    const spec = buildTestSpec();
    driveToExecuting({ store, spec, now: () => NOW });
    expect(store.getSpecByRun(spec.runId)).toEqual(spec);
  });

  it('sets run.specId to the spec id', () => {
    const store = freshStore();
    seedQueuedRun(store);
    const run = driveToExecuting({
      store,
      spec: buildTestSpec(),
      now: () => NOW,
    });
    expect(run.specId).toBe('spec-run-1');
  });

  it('records all 5 events in order', () => {
    const store = freshStore();
    seedQueuedRun(store);
    driveToExecuting({ store, spec: buildTestSpec(), now: () => NOW });
    const events = store.listEvents(RunId('run-1'));
    expect(events.map((e) => e.event.type)).toEqual([
      'start_triage',
      'triage_succeeded',
      'spec_approved',
      'planning_succeeded',
      'plan_approved',
    ]);
  });

  it('bumps version to 5 (one increment per event)', () => {
    const store = freshStore();
    seedQueuedRun(store);
    const run = driveToExecuting({
      store,
      spec: buildTestSpec(),
      now: () => NOW,
    });
    expect(run.version).toBe(5);
  });

  it('logs progress when a logger is provided', () => {
    const store = freshStore();
    seedQueuedRun(store);
    const records: string[] = [];
    // Build a minimal Logger-shape stub. We only need .info / .child for
    // driveToExecuting; child is unused, debug/warn/error not called.
    const logger = {
      info: (msg: string): void => {
        records.push(msg);
      },
      debug: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
      child: (): never => {
        throw new Error('not used in drive');
      },
    } as unknown as Parameters<typeof driveToExecuting>[0]['logger'];
    driveToExecuting({
      store,
      spec: buildTestSpec(),
      now: () => NOW,
      logger,
    });
    expect(records).toEqual([
      'drive: queued -> triaging',
      'drive: triaging -> awaiting_spec_approval',
      'drive: awaiting_spec_approval -> planning',
      'drive: planning -> awaiting_plan_approval',
      'drive: awaiting_plan_approval -> executing',
    ]);
  });

  it('throws InvalidTransitionError if the run is not in queued', () => {
    const store = freshStore();
    const run: Run = {
      ...seedQueuedRun(store),
      phase: 'executing',
    };
    // Overwrite the queued row with an executing one.
    store.updateRunByVersion({ ...run, version: 1 }, 0);
    expect(() =>
      driveToExecuting({ store, spec: buildTestSpec(), now: () => NOW }),
    ).toThrow(InvalidTransitionError);
  });
});
