import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  instrument,
  formatPerPhaseCost,
} from '../../src/eval/instrumentation.js';
import type { EvalTaskResult } from '../../src/eval/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-loop-instr-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makePlannerJson(
  taskName: string,
  runId: string,
  approach: string,
  risks: string[] = [],
  ok = true,
): void {
  const dir = join(root, taskName, runId);
  mkdirSync(dir, { recursive: true });
  const result = ok
    ? {
        ok: true,
        plan: {
          filesToTouch: [{ path: 'src/x.js', action: 'modify', reason: 'r' }],
          approach,
          risks,
          testStrategy: 'run tests',
        },
        usages: [],
      }
    : {
        ok: false,
        reason: 'unimplementable',
        message: 'cannot',
        usages: [],
      };
  writeFileSync(
    join(dir, 'planner.json'),
    JSON.stringify({ schemaVersion: 1, result, durationMs: 1234 }),
  );
}

function mkResult(overrides: Partial<EvalTaskResult>): EvalTaskResult {
  return {
    name: 't',
    passed: true,
    phase: 'done',
    runId: 'eval-t',
    durationMs: 0,
    tokensSpent: 0,
    costUsd: 0,
    cacheHitRate: 0,
    perPhase: {},
    failure: null,
    ...overrides,
  };
}

describe('instrument: context-seeking signal', () => {
  it('flags planners that mention "need to see"', () => {
    makePlannerJson('t1', 'r1', 'I would need to see the existing types first.');
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.plannerSignals.withPlannerOutput).toBe(1);
    expect(r.plannerSignals.contextSeekingCount).toBe(1);
    expect(r.plannerSignals.contextSeekingRate).toBe(1);
    expect(r.plannerSignals.perTask[0]?.matchedPhrases).toContain('need to see');
  });

  it('does NOT flag planners with no context-seeking language', () => {
    makePlannerJson('t1', 'r1', 'Add the helper and update tests.');
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.plannerSignals.contextSeekingCount).toBe(0);
    expect(r.plannerSignals.contextSeekingRate).toBe(0);
  });

  it('catches phrases in the risks list too', () => {
    makePlannerJson(
      't1',
      'r1',
      'straightforward change.',
      ['the result depends on the existing schema, which is unclear from the spec'],
    );
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.plannerSignals.contextSeekingCount).toBe(1);
    expect(r.plannerSignals.perTask[0]?.matchedPhrases.length).toBeGreaterThan(0);
  });

  it('treats rejected planner outputs as "no context-seeking"', () => {
    makePlannerJson('t1', 'r1', '', [], false);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.plannerSignals.withPlannerOutput).toBe(1);
    expect(r.plannerSignals.contextSeekingCount).toBe(0);
  });

  it('aggregates rate across multiple tasks', () => {
    makePlannerJson('t1', 'r1', 'I cannot determine the right approach.');
    makePlannerJson('t2', 'r2', 'Clean rename, no context concerns.');
    makePlannerJson('t3', 'r3', 'More context would help here.');
    const r = instrument(
      root,
      [mkResult({ name: 't1' }), mkResult({ name: 't2' }), mkResult({ name: 't3' })],
    );
    expect(r.plannerSignals.withPlannerOutput).toBe(3);
    expect(r.plannerSignals.contextSeekingCount).toBe(2);
    expect(r.plannerSignals.contextSeekingRate).toBeCloseTo(2 / 3);
  });

  it('returns zero rate when no planner outputs exist (baseline runs)', () => {
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.plannerSignals.withPlannerOutput).toBe(0);
    expect(r.plannerSignals.contextSeekingRate).toBe(0);
  });
});

describe('instrument: plan-quality mismatches', () => {
  it('flags a run that planned then failed in executor', () => {
    // No planner.json needed for this check; uses per-phase metrics.
    const r = instrument(root, [
      mkResult({
        name: 't1',
        passed: false,
        phase: 'failed',
        perPhase: {
          planning: { durationMs: 5000, tokensSpent: 1000, costUsd: 0.02, cacheReadTokens: 0, totalInputTokens: 1000 },
          executing: { durationMs: 30_000, tokensSpent: 5000, costUsd: 0.1, cacheReadTokens: 0, totalInputTokens: 5000 },
        },
        failure: { category: 'execution_error', message: 'agent crashed', phase: 'executing' },
      }),
    ]);
    expect(r.planQualityMismatches).toHaveLength(1);
    expect(r.planQualityMismatches[0]?.name).toBe('t1');
    expect(r.planQualityMismatches[0]?.failedPhase).toBe('executing');
  });

  it('does NOT flag a run that failed at planning itself', () => {
    const r = instrument(root, [
      mkResult({
        name: 't1',
        passed: false,
        phase: 'failed',
        perPhase: {
          planning: { durationMs: 5000, tokensSpent: 0, costUsd: 0, cacheReadTokens: 0, totalInputTokens: 0 },
          // No executing entry — never got there.
        },
        failure: { category: 'spec_invalid', message: 'planner rejected', phase: 'planning' },
      }),
    ]);
    expect(r.planQualityMismatches).toHaveLength(0);
  });

  it('does NOT flag a successful run', () => {
    const r = instrument(root, [
      mkResult({
        name: 't1',
        passed: true,
        phase: 'done',
        perPhase: {
          planning: { durationMs: 5000, tokensSpent: 1000, costUsd: 0.02, cacheReadTokens: 0, totalInputTokens: 1000 },
          executing: { durationMs: 30_000, tokensSpent: 5000, costUsd: 0.1, cacheReadTokens: 0, totalInputTokens: 5000 },
        },
        failure: null,
      }),
    ]);
    expect(r.planQualityMismatches).toHaveLength(0);
  });

  it('does NOT flag a baseline run (no planning duration) that failed', () => {
    const r = instrument(root, [
      mkResult({
        name: 't1',
        passed: false,
        phase: 'failed',
        perPhase: {
          executing: { durationMs: 30_000, tokensSpent: 5000, costUsd: 0.1, cacheReadTokens: 0, totalInputTokens: 5000 },
        },
        failure: { category: 'execution_error', message: 'x', phase: 'executing' },
      }),
    ]);
    expect(r.planQualityMismatches).toHaveLength(0);
  });
});

describe('formatPerPhaseCost', () => {
  it('renders a markdown table of per-phase metrics', () => {
    const out = formatPerPhaseCost(
      mkResult({
        name: 'sample',
        perPhase: {
          triaging: { durationMs: 4000, tokensSpent: 1000, costUsd: 0.005, cacheReadTokens: 0, totalInputTokens: 1000 },
          planning: { durationMs: 8000, tokensSpent: 7000, costUsd: 0.03, cacheReadTokens: 0, totalInputTokens: 7000 },
          executing: { durationMs: 40_000, tokensSpent: 100_000, costUsd: 0.15, cacheReadTokens: 0, totalInputTokens: 100_000 },
        },
      }),
    );
    expect(out).toContain('Per-phase cost breakdown: `sample`');
    expect(out).toContain('| triaging | 4.0s | 1000 | $0.0050 |');
    expect(out).toContain('| planning | 8.0s | 7000 | $0.0300 |');
    expect(out).toContain('| executing | 40.0s | 100000 | $0.1500 |');
  });
});
