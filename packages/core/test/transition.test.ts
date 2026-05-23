import { describe, expect, it } from 'vitest';
import {
  transition,
  InvalidTransitionError,
  allowedEvents,
  type Event,
} from '../src/state/transition.js';
import { createRun } from '../src/state/create.js';
import { RunId, TaskId, SpecId, type Run, type Phase } from '../src/types/index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:01:00.000Z';

function freshRun(): Run {
  return createRun({
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    artifactDir: '/runs/run-1',
    branch: 'agent/run-1',
    now: NOW,
  });
}

// Drive the run to a specific phase using the happy path.
// Note: phase names describe what's happening; entering a phase IS starting that work.
// So `spec_approved` moves us directly from awaiting_spec_approval -> planning, etc.
function runInPhase(phase: Phase): Run {
  let r = freshRun();
  if (r.phase === phase) return r;
  const path: Event[] = [
    { type: 'start_triage' },
    { type: 'triage_succeeded', specId: SpecId('spec-1') },
    { type: 'spec_approved' },
    { type: 'planning_succeeded' },
    { type: 'plan_approved' },
    { type: 'execution_succeeded' },
    { type: 'verification_succeeded' },
    { type: 'pr_opened', url: 'https://example.test/pull/1' },
  ];
  for (const event of path) {
    r = transition(r, event, NOW);
    if (r.phase === phase) return r;
  }
  throw new Error(`Could not reach phase ${phase}; ended at ${r.phase}`);
}

describe('createRun', () => {
  it('starts in queued phase', () => {
    const r = freshRun();
    expect(r.phase).toBe('queued');
    expect(r.version).toBe(0);
    expect(r.attemptCount).toBe(0);
    expect(r.tokensSpent).toBe(0);
  });
});

describe('happy path', () => {
  it('walks queued -> done through every phase', () => {
    let r = freshRun();
    const phases: Phase[] = [r.phase];

    r = transition(r, { type: 'start_triage' }, NOW);
    phases.push(r.phase);
    r = transition(r, { type: 'triage_succeeded', specId: SpecId('spec-1') }, NOW);
    phases.push(r.phase);
    r = transition(r, { type: 'spec_approved' }, NOW);
    phases.push(r.phase);
    r = transition(r, { type: 'planning_succeeded' }, NOW);
    phases.push(r.phase);
    r = transition(r, { type: 'plan_approved' }, NOW);
    phases.push(r.phase);
    r = transition(r, { type: 'execution_succeeded' }, NOW);
    phases.push(r.phase);
    r = transition(r, { type: 'verification_succeeded' }, NOW);
    phases.push(r.phase);
    r = transition(r, { type: 'pr_opened', url: 'https://github.com/x/y/pull/1' }, NOW);
    phases.push(r.phase);

    expect(phases).toEqual([
      'queued',
      'triaging',
      'awaiting_spec_approval',
      'planning',
      'awaiting_plan_approval',
      'executing',
      'verifying',
      'opening_pr',
      'done',
    ]);
    expect(r.version).toBe(8);
  });

  it('records specId when triage succeeds', () => {
    let r = transition(freshRun(), { type: 'start_triage' }, NOW);
    r = transition(r, { type: 'triage_succeeded', specId: SpecId('spec-42') }, NOW);
    expect(r.specId).toBe('spec-42');
  });

  it('records prUrl when pr_opened is applied', () => {
    const r = runInPhase('opening_pr');
    const next = transition(
      r,
      { type: 'pr_opened', url: 'https://github.com/foo/bar/pull/42' },
      NOW,
    );
    expect(next.phase).toBe('done');
    expect(next.prUrl).toBe('https://github.com/foo/bar/pull/42');
  });

  it('updates updatedAt and increments version on every transition', () => {
    const r1 = freshRun();
    const r2 = transition(r1, { type: 'start_triage' }, LATER);
    expect(r2.updatedAt).toBe(LATER);
    expect(r2.version).toBe(r1.version + 1);
  });
});

describe('invalid transitions', () => {
  it('throws when applying an event not allowed in current phase', () => {
    const r = freshRun(); // queued
    expect(() => transition(r, { type: 'execution_succeeded' }, NOW)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on any event in terminal phase done', () => {
    const r = runInPhase('done');
    expect(() => transition(r, { type: 'start_triage' }, NOW)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on any event in terminal phase failed', () => {
    let r = transition(freshRun(), { type: 'start_triage' }, NOW);
    r = transition(
      r,
      { type: 'triage_failed', failure: { category: 'internal', message: 'boom' } },
      NOW,
    );
    expect(r.phase).toBe('failed');
    expect(() => transition(r, { type: 'spec_approved' }, NOW)).toThrow(
      InvalidTransitionError,
    );
  });

  it('error carries the from-phase and event-type', () => {
    const r = freshRun();
    try {
      transition(r, { type: 'pr_opened', url: 'https://x/pull/1' }, NOW);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe('queued');
      expect(err.event).toBe('pr_opened');
    }
  });
});

describe('failure handling', () => {
  it('captures failure on triage_failed', () => {
    let r = transition(freshRun(), { type: 'start_triage' }, NOW);
    r = transition(
      r,
      {
        type: 'triage_failed',
        failure: { category: 'spec_invalid', message: 'no test commands' },
      },
      NOW,
    );
    expect(r.phase).toBe('failed');
    expect(r.failure).toEqual({
      category: 'spec_invalid',
      message: 'no test commands',
      phase: 'triaging',
    });
  });

  it('captures failure on verification_failed with correct phase', () => {
    const r = runInPhase('verifying');
    const after = transition(
      r,
      {
        type: 'verification_failed',
        failure: { category: 'verification_failed', message: 'tests red' },
      },
      NOW,
    );
    expect(after.phase).toBe('failed');
    expect(after.failure?.phase).toBe('verifying');
  });
});

describe('abandonment', () => {
  it('can abandon from any non-terminal phase', () => {
    const nonTerminal: Phase[] = [
      'queued',
      'triaging',
      'awaiting_spec_approval',
      'planning',
      'awaiting_plan_approval',
      'executing',
      'verifying',
      'opening_pr',
    ];
    for (const phase of nonTerminal) {
      const r = runInPhase(phase);
      const after = transition(r, { type: 'abandon', reason: 'user stop' }, NOW);
      expect(after.phase).toBe('abandoned');
      expect(after.abandonedReason).toBe('user stop');
    }
  });

  it('cannot abandon from terminal phase', () => {
    const r = runInPhase('done');
    expect(() => transition(r, { type: 'abandon', reason: 'too late' }, NOW)).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('non-phase-changing events', () => {
  it('record_token_usage accumulates tokens without phase change', () => {
    const r1 = runInPhase('executing');
    const r2 = transition(r1, { type: 'record_token_usage', tokens: 1000 }, NOW);
    const r3 = transition(r2, { type: 'record_token_usage', tokens: 500 }, NOW);
    expect(r3.phase).toBe('executing');
    expect(r3.tokensSpent).toBe(1500);
    expect(r3.version).toBe(r1.version + 2);
  });

  it('record_token_usage accepts an optional structured usage payload', () => {
    const r1 = runInPhase('executing');
    const r2 = transition(
      r1,
      {
        type: 'record_token_usage',
        tokens: 1234,
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 4,
          costUsd: 0.0123,
        },
      },
      NOW,
    );
    // tokens (the operand) is what advances tokensSpent.
    expect(r2.tokensSpent).toBe(1234);
    // The usage payload itself is part of the event, not the Run — Run keeps
    // only the running sum. The audit trail (events table) carries the breakdown.
    expect(r2.phase).toBe('executing');
  });

  it('increment_attempt bumps attemptCount within a phase', () => {
    const r1 = runInPhase('executing');
    const r2 = transition(r1, { type: 'increment_attempt' }, NOW);
    expect(r2.attemptCount).toBe(r1.attemptCount + 1);
    expect(r2.phase).toBe('executing');
  });

  it('attemptCount resets to 0 on phase change', () => {
    let r = runInPhase('executing');
    r = transition(r, { type: 'increment_attempt' }, NOW);
    r = transition(r, { type: 'increment_attempt' }, NOW);
    expect(r.attemptCount).toBe(2);
    r = transition(r, { type: 'execution_succeeded' }, NOW);
    expect(r.attemptCount).toBe(0);
  });
});

describe('allowedEvents', () => {
  it('returns abandon for non-terminal phases', () => {
    expect(allowedEvents('queued')).toContain('abandon');
    expect(allowedEvents('executing')).toContain('abandon');
  });

  it('returns no events for terminal phases except phase-changing ones (none)', () => {
    expect(allowedEvents('done')).toEqual([]);
    expect(allowedEvents('failed')).toEqual([]);
    expect(allowedEvents('abandoned')).toEqual([]);
  });

  it('includes non-phase-changing events in non-terminal phases', () => {
    const events = allowedEvents('executing');
    expect(events).toContain('record_token_usage');
    expect(events).toContain('record_time_spent');
    expect(events).toContain('increment_attempt');
  });
});
