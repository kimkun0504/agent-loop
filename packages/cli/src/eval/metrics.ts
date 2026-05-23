/**
 * Compute per-phase and per-run metrics from a Run's event log.
 *
 * Approach: walk events in order, tracking the current phase via phase-
 * changing event types. record_token_usage and record_time_spent events
 * attribute to the phase they were emitted within (which is the phase
 * AFTER the most recent phase-changing event applied).
 *
 * Phase durations are computed from event `appliedAt` timestamps: the
 * duration of phase P is `(timestamp of leaving event) - (timestamp of
 * entering event)`. The "entering event" for phase P is the event whose
 * transition lands the run IN phase P.
 */

import type { Phase } from '@agent-loop/core';
import type { EventRecord } from '@agent-loop/runtime';
import type { PhaseMetrics, EvalTaskResult } from './types.js';

/**
 * Returns the phase a run is in AFTER applying an event from a given prior
 * phase. Mirrors the TRANSITIONS table in core/state/transition.ts but only
 * for the subset of events the eval flow exercises. Returns null for events
 * that don't change phase.
 */
function nextPhaseAfter(prior: Phase, type: string): Phase | null {
  // Map only the phase-changing events we care about. Anything else
  // (record_token_usage, record_time_spent, increment_attempt) returns null.
  const table: Record<string, Partial<Record<Phase, Phase>>> = {
    start_triage:           { queued: 'triaging' },
    triage_succeeded:       { triaging: 'awaiting_spec_approval' },
    triage_failed:          { triaging: 'failed' },
    spec_approved:          { awaiting_spec_approval: 'planning' },
    spec_rejected:          { awaiting_spec_approval: 'failed' },
    planning_succeeded:     { planning: 'awaiting_plan_approval' },
    planning_failed:        { planning: 'failed' },
    plan_approved:          { awaiting_plan_approval: 'executing' },
    plan_rejected:          { awaiting_plan_approval: 'failed' },
    execution_succeeded:    { executing: 'verifying' },
    execution_failed:       { executing: 'failed' },
    verification_succeeded: { verifying: 'opening_pr' },
    verification_failed:    { verifying: 'failed' },
    pr_opened:              { opening_pr: 'done' },
    pr_failed:              { opening_pr: 'failed' },
    abandon: {
      queued: 'abandoned', triaging: 'abandoned',
      awaiting_spec_approval: 'abandoned', planning: 'abandoned',
      awaiting_plan_approval: 'abandoned', executing: 'abandoned',
      verifying: 'abandoned', opening_pr: 'abandoned',
    },
  };
  return table[type]?.[prior] ?? null;
}

export interface RunMetrics {
  durationMs: number;
  perPhase: Partial<Record<Phase, PhaseMetrics>>;
  totals: {
    tokensSpent: number;
    costUsd: number;
    cacheReadTokens: number;
    totalInputTokens: number;
  };
}

export function computeRunMetrics(events: ReadonlyArray<EventRecord>): RunMetrics {
  const perPhase: Partial<Record<Phase, PhaseMetrics>> = {};
  const totals = {
    tokensSpent: 0,
    costUsd: 0,
    cacheReadTokens: 0,
    totalInputTokens: 0,
  };

  if (events.length === 0) {
    return { durationMs: 0, perPhase, totals };
  }

  // Tracks: at each step, what phase are we currently IN?
  let currentPhase: Phase = 'queued';
  // When we entered the current phase.
  let phaseEnteredAt: string = events[0]!.appliedAt;

  const tsMs = (s: string): number => new Date(s).getTime();

  const ensure = (phase: Phase): PhaseMetrics => {
    let m = perPhase[phase];
    if (!m) {
      m = {
        durationMs: 0,
        tokensSpent: 0,
        costUsd: 0,
        cacheReadTokens: 0,
        totalInputTokens: 0,
      };
      perPhase[phase] = m;
    }
    return m;
  };

  for (const rec of events) {
    const type = rec.event.type;
    const next = nextPhaseAfter(currentPhase, type);

    if (next !== null) {
      // Phase transition: close out the current phase's duration.
      const m = ensure(currentPhase);
      m.durationMs += tsMs(rec.appliedAt) - tsMs(phaseEnteredAt);
      currentPhase = next;
      phaseEnteredAt = rec.appliedAt;
      // Initialize the new phase's bucket so it shows up in perPhase even
      // when no token/time events fire within it (e.g. opening_pr).
      ensure(currentPhase);
    } else if (type === 'record_token_usage') {
      const m = ensure(currentPhase);
      const ev = rec.event as Extract<typeof rec.event, { type: 'record_token_usage' }>;
      m.tokensSpent += ev.tokens;
      totals.tokensSpent += ev.tokens;
      if (ev.usage) {
        const u = ev.usage;
        const cacheRead = u.cacheReadInputTokens ?? 0;
        const cacheCreate = u.cacheCreationInputTokens ?? 0;
        const inputForRate = u.inputTokens + cacheRead + cacheCreate;
        m.cacheReadTokens += cacheRead;
        m.totalInputTokens += inputForRate;
        totals.cacheReadTokens += cacheRead;
        totals.totalInputTokens += inputForRate;
        if (u.costUsd !== undefined) {
          m.costUsd += u.costUsd;
          totals.costUsd += u.costUsd;
        }
      }
    }
    // record_time_spent / increment_attempt: tracked elsewhere (Run.secondsSpent,
    // Run.attemptCount). Not needed for per-phase metrics here.
  }

  // Final phase's duration: from when we entered it to the last event.
  const last = events[events.length - 1]!;
  const m = ensure(currentPhase);
  m.durationMs += tsMs(last.appliedAt) - tsMs(phaseEnteredAt);

  const first = events[0]!;
  const durationMs = tsMs(last.appliedAt) - tsMs(first.appliedAt);

  return { durationMs, perPhase, totals };
}

// --- Aggregation helpers ---------------------------------------------------

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function cacheHitRate(cacheReadTokens: number, totalInputTokens: number): number {
  if (totalInputTokens === 0) return 0;
  return cacheReadTokens / totalInputTokens;
}

export function aggregateResults(results: ReadonlyArray<EvalTaskResult>): {
  p50DurationMs: number;
  p95DurationMs: number;
  p50CostUsd: number;
  p95CostUsd: number;
  medianCostUsd: number;
  p50CacheHitRate: number;
} {
  const durations = results.map((r) => r.durationMs);
  const costs = results.map((r) => r.costUsd);
  const cacheRates = results.map((r) => r.cacheHitRate);
  return {
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    p50CostUsd: percentile(costs, 50),
    p95CostUsd: percentile(costs, 95),
    medianCostUsd: median(costs),
    p50CacheHitRate: percentile(cacheRates, 50),
  };
}
