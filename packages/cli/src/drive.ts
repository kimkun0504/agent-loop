/**
 * driveToExecuting: walk a freshly-created Run from `queued` to `executing`
 * by applying the five events that the triage/planner agents would normally
 * emit. In week 2 those agents don't exist yet, so the CLI does the work
 * synchronously with the hardcoded spec.
 *
 *   queued
 *     -> [start_triage]        triaging
 *     -> insertSpec(spec)
 *     -> [triage_succeeded]    awaiting_spec_approval
 *     -> [spec_approved]       planning
 *     -> [planning_succeeded]  awaiting_plan_approval
 *     -> [plan_approved]       executing
 *
 * Each event goes through applyEvent (single sanctioned mutator), so the
 * audit trail is identical to what real agents would produce.
 */

import {
  type Logger,
  type Run,
  type Spec,
} from '@agent-loop/core';
import { applyEvent, type Store } from '@agent-loop/runtime';

export interface DriveOptions {
  store: Store;
  spec: Spec;
  now: () => string;
  logger?: Logger;
}

export function driveToExecuting(opts: DriveOptions): Run {
  const { store, spec, now, logger } = opts;
  const runId = spec.runId;

  let run = applyEvent(store, runId, { type: 'start_triage' }, now());
  logger?.info('drive: queued -> triaging', { runId });

  store.insertSpec(spec);
  run = applyEvent(
    store,
    runId,
    { type: 'triage_succeeded', specId: spec.id },
    now(),
  );
  logger?.info('drive: triaging -> awaiting_spec_approval', {
    runId,
    specId: spec.id,
  });

  run = applyEvent(store, runId, { type: 'spec_approved' }, now());
  logger?.info('drive: awaiting_spec_approval -> planning', { runId });

  run = applyEvent(store, runId, { type: 'planning_succeeded' }, now());
  logger?.info('drive: planning -> awaiting_plan_approval', { runId });

  run = applyEvent(store, runId, { type: 'plan_approved' }, now());
  logger?.info('drive: awaiting_plan_approval -> executing', { runId });

  return run;
}
