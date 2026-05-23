/**
 * applyEvent — the only sanctioned mutator of Run state.
 *
 * Owns the read-transition-write transaction internally:
 *   1. Read the run by id.
 *   2. Call core.transition() — pure, throws InvalidTransitionError on bad events.
 *   3. Persist via updateRunByVersion with the run's prior version as the guard.
 *   4. Append the event row.
 *
 * Everything happens inside store.transaction(); any throw rolls back the
 * whole tx so we never leave a half-applied state. Bypassing this function
 * (calling store.insertEvent directly to record a state change) breaks the
 * audit trail and the version guard. Don't.
 */

import { transition, type Event, type Run, type RunId } from '@agent-loop/core';
import type { Store } from '../db/store.js';
import { RunNotFoundError, VersionConflictError } from './errors.js';

/**
 * The slice of Store that applyEvent depends on. Declared explicitly so tests
 * can provide a stub without instantiating SQLite. The real Store class
 * satisfies this shape structurally.
 */
export type ApplyEventStore = Pick<
  Store,
  'transaction' | 'getRun' | 'updateRunByVersion' | 'insertEvent'
>;

export function applyEvent(
  store: ApplyEventStore,
  runId: RunId,
  event: Event,
  now?: string,
): Run {
  const ts = now ?? new Date().toISOString();
  return store.transaction(() => {
    const current = store.getRun(runId);
    if (!current) throw new RunNotFoundError(runId);

    const next = transition(current, event, ts);

    const ok = store.updateRunByVersion(next, current.version);
    if (!ok) throw new VersionConflictError(runId, current.version);

    appendEvent(store, runId, event, next.version, ts);
    return next;
  });
}

// File-private. The package's only sanctioned event-recording path is
// applyEvent above. We do not export this; we do not invoke it from
// anywhere else in the runtime.
function appendEvent(
  store: ApplyEventStore,
  runId: RunId,
  event: Event,
  versionAfter: number,
  appliedAt: string,
): void {
  store.insertEvent(runId, event, versionAfter, appliedAt);
}
