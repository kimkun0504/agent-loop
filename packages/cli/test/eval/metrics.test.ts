import { describe, expect, it } from 'vitest';
import {
  computeRunMetrics,
  percentile,
  median,
  cacheHitRate,
  aggregateResults,
} from '../../src/eval/metrics.js';
import type { EventRecord } from '@agent-loop/runtime';
import { RunId, SpecId } from '@agent-loop/core';
import type { EvalTaskResult } from '../../src/eval/types.js';

function event(
  type: EventRecord['event']['type'],
  ts: string,
  extra: Record<string, unknown> = {},
): EventRecord {
  return {
    id: 0,
    runId: RunId('run-x'),
    event: { type, ...extra } as EventRecord['event'],
    appliedAt: ts,
    runVersionAfter: 1,
  };
}

describe('computeRunMetrics — Phase A (no triage/planner events emit usage)', () => {
  it('attributes record_token_usage to the phase it was emitted within', () => {
    // queued -> triaging -> awaiting_spec_approval -> planning ->
    // awaiting_plan_approval -> executing -> verifying -> opening_pr -> done
    const events: EventRecord[] = [
      event('start_triage',           '2026-05-23T20:00:00.000Z'),
      event('triage_succeeded',       '2026-05-23T20:00:00.100Z', { specId: SpecId('s1') }),
      event('spec_approved',          '2026-05-23T20:00:00.200Z'),
      event('planning_succeeded',     '2026-05-23T20:00:00.300Z'),
      event('plan_approved',          '2026-05-23T20:00:00.400Z'),
      // — now in executing —
      event('record_token_usage',     '2026-05-23T20:00:42.000Z', {
        tokens: 1234,
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 30, cacheCreationInputTokens: 4, costUsd: 0.05 },
      }),
      event('execution_succeeded',    '2026-05-23T20:00:42.100Z'),
      // — now in verifying —
      event('verification_succeeded', '2026-05-23T20:00:43.000Z'),
      // — now in opening_pr —
      event('pr_opened',              '2026-05-23T20:00:43.500Z', { url: 'eval://x' }),
    ];

    const m = computeRunMetrics(events);
    expect(m.totals.tokensSpent).toBe(1234);
    expect(m.totals.costUsd).toBeCloseTo(0.05);
    expect(m.totals.cacheReadTokens).toBe(30);
    expect(m.totals.totalInputTokens).toBe(1034); // 1000 + 30 + 4

    const executing = m.perPhase['executing'];
    expect(executing).toBeDefined();
    expect(executing?.tokensSpent).toBe(1234);
    expect(executing?.costUsd).toBeCloseTo(0.05);
    expect(executing?.cacheReadTokens).toBe(30);

    // Other phases should not have token usage.
    expect(m.perPhase['triaging']?.tokensSpent).toBe(0);
    expect(m.perPhase['verifying']?.tokensSpent).toBe(0);
  });

  it('records per-phase durations from appliedAt deltas', () => {
    const events: EventRecord[] = [
      event('start_triage',           '2026-05-23T20:00:00.000Z'),
      event('triage_succeeded',       '2026-05-23T20:00:10.000Z', { specId: SpecId('s') }),
      event('spec_approved',          '2026-05-23T20:00:11.000Z'),
      event('planning_succeeded',     '2026-05-23T20:00:12.000Z'),
      event('plan_approved',          '2026-05-23T20:00:13.000Z'),
      event('execution_succeeded',    '2026-05-23T20:00:53.000Z'),
      event('verification_succeeded', '2026-05-23T20:00:55.000Z'),
      event('pr_opened',              '2026-05-23T20:00:56.000Z', { url: 'eval://x' }),
    ];
    const m = computeRunMetrics(events);
    // triaging: 0.000Z → 10.000Z = 10 s
    expect(m.perPhase['triaging']?.durationMs).toBe(10_000);
    // executing: 13.000Z → 53.000Z = 40 s
    expect(m.perPhase['executing']?.durationMs).toBe(40_000);
    // Total run wall clock: 0.000Z → 56.000Z = 56 s
    expect(m.durationMs).toBe(56_000);
  });

  it('treats failure paths as terminal — no further phase attribution', () => {
    const events: EventRecord[] = [
      event('start_triage',        '2026-05-23T20:00:00.000Z'),
      event('triage_succeeded',    '2026-05-23T20:00:01.000Z', { specId: SpecId('s') }),
      event('spec_approved',       '2026-05-23T20:00:02.000Z'),
      event('planning_succeeded',  '2026-05-23T20:00:03.000Z'),
      event('plan_approved',       '2026-05-23T20:00:04.000Z'),
      event('record_token_usage',  '2026-05-23T20:00:10.000Z', { tokens: 500 }),
      event('execution_failed',    '2026-05-23T20:00:11.000Z', {
        failure: { category: 'execution_error', message: 'agent crashed' },
      }),
    ];
    const m = computeRunMetrics(events);
    expect(m.perPhase['executing']?.tokensSpent).toBe(500);
    expect(m.perPhase['failed']).toBeDefined();
    expect(m.totals.tokensSpent).toBe(500);
  });

  it('handles empty event list', () => {
    const m = computeRunMetrics([]);
    expect(m.durationMs).toBe(0);
    expect(m.totals.tokensSpent).toBe(0);
    expect(m.perPhase).toEqual({});
  });
});

describe('percentile / median', () => {
  it('percentile 50 on a sorted-input list', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });
  it('percentile 95 on a 20-item list', () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(19);
  });
  it('percentile on empty returns 0', () => {
    expect(percentile([], 50)).toBe(0);
  });
  it('median on odd-length sorted list', () => {
    expect(median([1, 2, 3])).toBe(2);
  });
  it('median on even-length list averages the middle two', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('cacheHitRate', () => {
  it('returns 0 when no input tokens', () => {
    expect(cacheHitRate(100, 0)).toBe(0);
  });
  it('computes a typical rate', () => {
    expect(cacheHitRate(30, 100)).toBeCloseTo(0.3);
  });
});

describe('aggregateResults', () => {
  it('produces aggregates from a small result list', () => {
    const results: EvalTaskResult[] = [
      mkResult({ durationMs: 1000, costUsd: 0.10, cacheHitRate: 0.5 }),
      mkResult({ durationMs: 2000, costUsd: 0.20, cacheHitRate: 0.7 }),
      mkResult({ durationMs: 3000, costUsd: 0.30, cacheHitRate: 0.9 }),
    ];
    const a = aggregateResults(results);
    expect(a.p50DurationMs).toBe(2000);
    expect(a.medianCostUsd).toBeCloseTo(0.20);
    expect(a.p50CacheHitRate).toBeCloseTo(0.7);
  });
});

function mkResult(overrides: Partial<EvalTaskResult>): EvalTaskResult {
  return {
    name: 'x',
    passed: true,
    phase: 'done',
    runId: 'eval-x',
    durationMs: 0,
    tokensSpent: 0,
    costUsd: 0,
    cacheHitRate: 0,
    perPhase: {},
    failure: null,
    ...overrides,
  };
}
