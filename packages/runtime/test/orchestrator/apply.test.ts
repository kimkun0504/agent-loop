import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  type Run,
  type Event,
  RunId,
  SpecId,
  TaskId,
  InvalidTransitionError,
} from '@agent-loop/core';
import { applyMigrations } from '../../src/db/migrate.js';
import { Store } from '../../src/db/store.js';
import {
  applyEvent,
  type ApplyEventStore,
} from '../../src/orchestrator/apply.js';
import {
  RunNotFoundError,
  VersionConflictError,
} from '../../src/orchestrator/errors.js';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:01:00.000Z';

function newStore(): Store {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, () => NOW);
  return new Store(db);
}

function seedRun(store: Store, overrides: Partial<Run> = {}): Run {
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
    ...overrides,
  };
  store.insertRun(run);
  return run;
}

describe('applyEvent: happy path', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
    seedRun(store);
  });

  it('advances the run through a valid transition', () => {
    const next = applyEvent(store, RunId('run-1'), { type: 'start_triage' }, LATER);
    expect(next.phase).toBe('triaging');
    expect(next.version).toBe(1);
    expect(next.updatedAt).toBe(LATER);
  });

  it('persists the new state to disk', () => {
    applyEvent(store, RunId('run-1'), { type: 'start_triage' }, LATER);
    const onDisk = store.getRun(RunId('run-1'))!;
    expect(onDisk.phase).toBe('triaging');
    expect(onDisk.version).toBe(1);
  });

  it('records the event with the correct post-update version', () => {
    applyEvent(store, RunId('run-1'), { type: 'start_triage' }, LATER);
    const events = store.listEvents(RunId('run-1'));
    expect(events.length).toBe(1);
    expect(events[0]?.event).toEqual({ type: 'start_triage' });
    expect(events[0]?.runVersionAfter).toBe(1);
    expect(events[0]?.appliedAt).toBe(LATER);
  });

  it('preserves event payload through serialization (triage_succeeded.specId)', () => {
    applyEvent(store, RunId('run-1'), { type: 'start_triage' }, LATER);
    applyEvent(
      store,
      RunId('run-1'),
      { type: 'triage_succeeded', specId: SpecId('spec-1') },
      LATER,
    );
    const events = store.listEvents(RunId('run-1'));
    expect(events[1]?.event).toEqual({
      type: 'triage_succeeded',
      specId: 'spec-1',
    });
    const run = store.getRun(RunId('run-1'))!;
    expect(run.specId).toBe('spec-1');
  });

  it('defaults `now` to the current time when not provided', () => {
    const before = new Date().toISOString();
    const next = applyEvent(store, RunId('run-1'), { type: 'start_triage' });
    const after = new Date().toISOString();
    expect(next.updatedAt >= before).toBe(true);
    expect(next.updatedAt <= after).toBe(true);
  });

  it('handles non-phase-changing events (record_token_usage)', () => {
    const next = applyEvent(
      store,
      RunId('run-1'),
      { type: 'record_token_usage', tokens: 1500 },
      LATER,
    );
    expect(next.phase).toBe('queued'); // unchanged
    expect(next.tokensSpent).toBe(1500);
    expect(next.version).toBe(1);
  });
});

describe('applyEvent: error paths', () => {
  let store: Store;
  beforeEach(() => {
    store = newStore();
  });

  it('throws RunNotFoundError when the run does not exist', () => {
    expect(() =>
      applyEvent(store, RunId('ghost'), { type: 'start_triage' }, LATER),
    ).toThrow(RunNotFoundError);
  });

  it('propagates InvalidTransitionError from core', () => {
    seedRun(store, { phase: 'queued' });
    // spec_approved is not legal from `queued`.
    expect(() =>
      applyEvent(store, RunId('run-1'), { type: 'spec_approved' }, LATER),
    ).toThrow(InvalidTransitionError);
  });

  it('rolls back when the transition is invalid — no event row, no state change', () => {
    seedRun(store, { phase: 'queued' });
    try {
      applyEvent(store, RunId('run-1'), { type: 'spec_approved' }, LATER);
    } catch {
      // expected
    }
    const onDisk = store.getRun(RunId('run-1'))!;
    expect(onDisk.phase).toBe('queued');
    expect(onDisk.version).toBe(0);
    expect(store.listEvents(RunId('run-1'))).toEqual([]);
  });
});

describe('applyEvent: version conflict', () => {
  /**
   * The version guard structurally cannot trip inside a single-connection
   * applyEvent call (the read and write happen in one transaction). It
   * exists as defense in depth against future concurrent writers and
   * accidental misuse. We test it by stubbing the store dependency so
   * updateRunByVersion returns false.
   */
  it('throws VersionConflictError when the update affects zero rows', () => {
    const seedRun: Run = {
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
    const inserted: Array<{ runId: string; event: Event }> = [];

    const stub: ApplyEventStore = {
      transaction: (fn) => fn(),
      getRun: () => seedRun,
      updateRunByVersion: () => false, // simulate raced-ahead writer
      insertEvent: (runId, event) => {
        inserted.push({ runId, event });
      },
    };

    expect(() =>
      applyEvent(stub, RunId('run-1'), { type: 'start_triage' }, LATER),
    ).toThrow(VersionConflictError);
    // The event must not have been recorded — applyEvent fails before that.
    expect(inserted).toEqual([]);
  });

  it('VersionConflictError carries the expected version', () => {
    const seedRun: Run = {
      id: RunId('run-1'),
      taskId: TaskId('task-1'),
      artifactDir: '/runs/run-1',
      branch: 'agent/run-1',
      phase: 'queued',
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
      attemptCount: 0,
      tokensSpent: 0,
      secondsSpent: 0,
    };
    const stub: ApplyEventStore = {
      transaction: (fn) => fn(),
      getRun: () => seedRun,
      updateRunByVersion: () => false,
      insertEvent: () => undefined,
    };
    try {
      applyEvent(stub, RunId('run-1'), { type: 'start_triage' }, LATER);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError);
      expect((err as VersionConflictError).expectedVersion).toBe(7);
      expect((err as VersionConflictError).runId).toBe('run-1');
    }
  });
});

describe('applyEvent: transaction atomicity', () => {
  it('rolls back the run update if event recording fails', () => {
    // Simulate insertEvent throwing AFTER updateRunByVersion succeeded.
    // The transaction should roll back, leaving the run untouched.
    let updated = false;
    const seedRunObj: Run = {
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
    const stub: ApplyEventStore = {
      transaction: (fn) => {
        // No real rollback in stub-land; we just verify the call ordering
        // and that the error propagates. The real Store delegates to
        // better-sqlite3's transaction wrapper, which does rollback on throw.
        return fn();
      },
      getRun: () => seedRunObj,
      updateRunByVersion: () => {
        updated = true;
        return true;
      },
      insertEvent: () => {
        throw new Error('FK violation');
      },
    };

    expect(() =>
      applyEvent(stub, RunId('run-1'), { type: 'start_triage' }, LATER),
    ).toThrow('FK violation');
    expect(updated).toBe(true); // we got past the update before the throw
  });

  it('real Store: a thrown insertEvent rolls back the run update', () => {
    // End-to-end check using the real store. We force a FK failure by
    // wrapping the real insertEvent with one that throws after the run
    // update has happened.
    const store = newStore();
    seedRun(store);

    const original = store.insertEvent.bind(store);
    store.insertEvent = (() => {
      throw new Error('simulated insert event failure');
    }) as typeof store.insertEvent;

    try {
      expect(() =>
        applyEvent(store, RunId('run-1'), { type: 'start_triage' }, LATER),
      ).toThrow('simulated insert event failure');
    } finally {
      store.insertEvent = original;
    }

    const onDisk = store.getRun(RunId('run-1'))!;
    expect(onDisk.phase).toBe('queued');
    expect(onDisk.version).toBe(0);
    expect(store.listEvents(RunId('run-1'))).toEqual([]);
  });
});
