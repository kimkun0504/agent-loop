/**
 * runLoop: the orchestrator's poll-and-tick driver.
 *
 * - Polling cadence is fixed at POLL_INTERVAL_MS = 2_000ms. Not a config
 *   knob for week 2 (per the v2 plan); when we want it tunable we'll add
 *   it then.
 * - Exits cleanly on STOP file or AbortSignal abort.
 * - tick() exceptions are logged but don't kill the loop — a single bad
 *   run shouldn't take down the orchestrator.
 *
 * Week 2's loop picks the first non-terminal run on every poll and ticks
 * it once. With one orchestrator per host and small fleets, that's enough.
 * Fairness/prioritization is a week-4 concern.
 */

import type { Phase } from '@agent-loop/core';
import { isStopRequested } from '../fs/stop.js';
import { tick, type Deps } from './tick.js';

export const POLL_INTERVAL_MS = 2_000;

export const NON_TERMINAL_PHASES: ReadonlyArray<Phase> = [
  'queued',
  'triaging',
  'awaiting_spec_approval',
  'planning',
  'awaiting_plan_approval',
  'executing',
  'verifying',
  'opening_pr',
];

export interface LoopOptions {
  signal?: AbortSignal;
}

export async function runLoop(
  deps: Deps,
  opts: LoopOptions = {},
): Promise<void> {
  const { signal } = opts;
  while (true) {
    if (signal?.aborted) {
      deps.logger.info('loop: abort received; exiting');
      return;
    }
    if (isStopRequested(deps.workspaceDir)) {
      deps.logger.info('loop: STOP file present; exiting');
      return;
    }

    const candidates = deps.store.listRuns({
      phase: [...NON_TERMINAL_PHASES],
    });

    if (candidates.length === 0) {
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }

    const next = candidates[0]!;
    try {
      await tick(deps, next);
    } catch (err) {
      // A bad tick must not crash the loop. Log and move on; the run will
      // either be retried on the next poll or — if it's in a corrupt state
      // — surface via the next inspect / list command.
      deps.logger.error('loop: tick threw', {
        runId: next.id,
        err: String(err),
      });
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
