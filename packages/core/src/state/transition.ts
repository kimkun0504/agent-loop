/**
 * The state machine.
 *
 * This is a pure function: (Run, Event) -> Run. No I/O, no side effects.
 * Every transition is explicit. Invalid transitions throw a typed error
 * so the orchestrator can decide whether to retry, log, or abandon.
 *
 * Why this matters: agent runs are non-deterministic at the *agent* layer,
 * but the *orchestration* layer must be 100% deterministic and replayable.
 * Bugs in the agent are tolerable. Bugs in the state machine corrupt history.
 */

import type {
  Phase,
  Run,
  RunId,
  SpecId,
  Failure,
  TokenUsage,
} from '../types/index.js';

// --- Events ----------------------------------------------------------------

/**
 * Events are the only way state changes. Every event is small, named, and
 * carries exactly the data needed for one transition.
 */
export type Event =
  | { type: 'start_triage' }
  | { type: 'triage_succeeded'; specId: SpecId }
  | { type: 'triage_failed'; failure: Omit<Failure, 'phase'> }
  | { type: 'spec_approved' }
  | { type: 'spec_rejected'; reason: string }
  | { type: 'planning_succeeded' }
  | { type: 'planning_failed'; failure: Omit<Failure, 'phase'> }
  | { type: 'plan_approved' }
  | { type: 'plan_rejected'; reason: string }
  | { type: 'execution_succeeded' }
  | { type: 'execution_failed'; failure: Omit<Failure, 'phase'> }
  | { type: 'verification_succeeded' }
  | { type: 'verification_failed'; failure: Omit<Failure, 'phase'> }
  | { type: 'pr_opened'; url: string }
  | { type: 'pr_failed'; failure: Omit<Failure, 'phase'> }
  | { type: 'abandon'; reason: string }
  | {
      type: 'record_token_usage';
      /**
       * Running-sum operand applied to Run.tokensSpent. Should equal the sum
       * of all token kinds in `usage` (input + output + cache_read + cache_creation)
       * when `usage` is present.
       */
      tokens: number;
      /** Optional structured breakdown for the audit trail. */
      usage?: TokenUsage;
    }
  | { type: 'record_time_spent'; seconds: number }
  | { type: 'increment_attempt' };

export type EventType = Event['type'];

// --- Errors ----------------------------------------------------------------

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: Phase,
    public readonly event: EventType,
  ) {
    super(`Invalid transition: cannot apply '${event}' in phase '${from}'`);
    this.name = 'InvalidTransitionError';
  }
}

// --- Transition table ------------------------------------------------------

/**
 * For each (current phase, event) pair, what phase do we move to?
 * Undefined means the transition is invalid.
 *
 * Kept as a nested record for two reasons:
 * 1. TypeScript can exhaustively check it.
 * 2. It's easy to read as a table when debugging.
 */
const TRANSITIONS: Partial<Record<Phase, Partial<Record<EventType, Phase>>>> = {
  queued: {
    start_triage: 'triaging',
    abandon: 'abandoned',
  },
  triaging: {
    triage_succeeded: 'awaiting_spec_approval',
    triage_failed: 'failed',
    abandon: 'abandoned',
  },
  awaiting_spec_approval: {
    spec_approved: 'planning',
    spec_rejected: 'failed',
    abandon: 'abandoned',
  },
  planning: {
    planning_succeeded: 'awaiting_plan_approval',
    planning_failed: 'failed',
    abandon: 'abandoned',
  },
  awaiting_plan_approval: {
    plan_approved: 'executing',
    plan_rejected: 'failed',
    abandon: 'abandoned',
  },
  executing: {
    execution_succeeded: 'verifying',
    execution_failed: 'failed',
    abandon: 'abandoned',
  },
  verifying: {
    verification_succeeded: 'opening_pr',
    // Verification can fail back to executing for retry, OR to failed terminally.
    // The transition function decides based on attemptCount vs budget.
    verification_failed: 'failed',
    abandon: 'abandoned',
  },
  opening_pr: {
    pr_opened: 'done',
    pr_failed: 'failed',
    abandon: 'abandoned',
  },
  // Terminal phases accept no events.
  done: {},
  failed: {},
  abandoned: {},
};

// --- The transition function ----------------------------------------------

/**
 * Apply an event to a run, producing a new run. Pure. Throws on invalid.
 *
 * Callers should treat this as the *only* way Run state changes. The DB
 * layer persists the result; it does not invent transitions of its own.
 */
export function transition(run: Run, event: Event, now: string): Run {
  // Events that don't cause phase changes are handled first.
  switch (event.type) {
    case 'record_token_usage':
      return {
        ...run,
        tokensSpent: run.tokensSpent + event.tokens,
        version: run.version + 1,
        updatedAt: now,
      };
    case 'record_time_spent':
      return {
        ...run,
        secondsSpent: run.secondsSpent + event.seconds,
        version: run.version + 1,
        updatedAt: now,
      };
    case 'increment_attempt':
      return {
        ...run,
        attemptCount: run.attemptCount + 1,
        version: run.version + 1,
        updatedAt: now,
      };
  }

  // Phase-changing events: look up the destination.
  const allowedFromPhase = TRANSITIONS[run.phase] ?? {};
  const nextPhase = allowedFromPhase[event.type];

  if (nextPhase === undefined) {
    throw new InvalidTransitionError(run.phase, event.type);
  }

  // Build the new run. Attempt counter resets on phase change.
  const base: Run = {
    ...run,
    phase: nextPhase,
    version: run.version + 1,
    updatedAt: now,
    attemptCount: 0,
  };

  // Apply event-specific field updates.
  switch (event.type) {
    case 'triage_succeeded':
      return { ...base, specId: event.specId };

    case 'triage_failed':
      return { ...base, failure: { ...event.failure, phase: 'triaging' } };

    case 'spec_rejected':
      return {
        ...base,
        failure: {
          category: 'spec_invalid',
          message: event.reason,
          phase: 'awaiting_spec_approval',
        },
      };

    case 'planning_failed':
      return { ...base, failure: { ...event.failure, phase: 'planning' } };

    case 'plan_rejected':
      return {
        ...base,
        failure: {
          category: 'plan_rejected',
          message: event.reason,
          phase: 'awaiting_plan_approval',
        },
      };

    case 'execution_failed':
      return { ...base, failure: { ...event.failure, phase: 'executing' } };

    case 'verification_failed':
      return { ...base, failure: { ...event.failure, phase: 'verifying' } };

    case 'pr_opened':
      return { ...base, prUrl: event.url };

    case 'pr_failed':
      return { ...base, failure: { ...event.failure, phase: 'opening_pr' } };

    case 'abandon':
      return { ...base, abandonedReason: event.reason };

    default:
      return base;
  }
}

// --- Helpers ---------------------------------------------------------------

/**
 * Returns the set of event types that are valid for a given phase.
 * Useful for the CLI to show what's possible, and for tests.
 */
export function allowedEvents(phase: Phase): EventType[] {
  const table = TRANSITIONS[phase] ?? {};
  const phaseChanging = Object.keys(table) as EventType[];
  // Non-phase-changing events are valid in any non-terminal phase.
  const isTerminalPhase = phase === 'done' || phase === 'failed' || phase === 'abandoned';
  if (isTerminalPhase) return phaseChanging;
  return [...phaseChanging, 'record_token_usage', 'record_time_spent', 'increment_attempt'];
}
