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

// Helper for triage anti-pattern tests.
function makeTriageJson(
  taskName: string,
  runId: string,
  acceptanceCriteria: string[],
): void {
  const dir = join(root, taskName, runId);
  mkdirSync(dir, { recursive: true });
  const result = {
    ok: true,
    spec: {
      title: 't',
      description: 'd',
      fileScope: ['src/**'],
      acceptanceCriteria,
      testCommands: ['npm test'],
    },
    usages: [],
  };
  writeFileSync(
    join(dir, 'triage.json'),
    JSON.stringify({ schemaVersion: 1, result, durationMs: 1234 }),
  );
}

describe('instrument: triage anti-pattern meta-test', () => {
  // Detects compound runtime-claim shapes (conjunction + runtime-claim
  // assertion within 60 chars). Tightened after CHECKPOINT 3 round 2's
  // false positive on "Nested objects and arrays pass through ...".

  it('detects "X exists and it still passes" compound', () => {
    makeTriageJson('t1', 'eval-t1', [
      'src/foo.js exports a parse function',
      'test/foo.test.js contains a test for X and it still passes',
    ]);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(1);
    expect(r.triageAntiPatternViolations[0]?.criterionIndex).toBe(1);
    expect(r.triageAntiPatternViolations[0]?.criterion).toMatch(/still passes/);
  });

  it('detects "remains unchanged and continues to pass"', () => {
    makeTriageJson('t1', 'eval-t1', [
      'the existing test in test/bar.test.js remains unchanged and continues to pass',
    ]);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(1);
  });

  it('detects "X exports Y and the new tests pass"', () => {
    makeTriageJson('t1', 'eval-t1', [
      'src/baz.js exports parseQuux and the new tests pass',
    ]);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(1);
  });

  it('detects "also" / "plus" / "while" / "moreover" conjunctions', () => {
    makeTriageJson('multi', 'eval-multi', [
      'X exists, also the tests pass',
      'Y is present plus the build succeeds',
      'Z is correct while existing tests still pass',
      'W is set up; moreover the new tests pass',
    ]);
    const r = instrument(root, [mkResult({ name: 'multi' })]);
    expect(r.triageAntiPatternViolations.length).toBe(4);
  });

  it('does NOT flag observable-only criteria', () => {
    makeTriageJson('t1', 'eval-t1', [
      'src/foo.js exports a parse function',
      'no occurrence of the token parseDate remains anywhere under src/',
      'test/email.test.js contains an assertion for the empty-string case',
      'src/email.js is unchanged from the initial commit',
    ]);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('does NOT flag "and" without a runtime keyword nearby', () => {
    makeTriageJson('t1', 'eval-t1', [
      'src/foo.js exports parse and src/bar.js imports it',
      'test file contains assertion for empty input and an assertion for whitespace',
    ]);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('does NOT flag a runtime keyword without a preceding conjunction', () => {
    makeTriageJson('t1', 'eval-t1', [
      // The regex requires a conjunction BEFORE the runtime keyword.
      'parseInt32 returns the parsed integer for valid inputs',
    ]);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('does NOT flag the "pass through" idiom (the CHECKPOINT 3 round-2 false positive)', () => {
    // This is the exact criterion that flipped the meta-test false-positive
    // in the post-Part-A 5-run gate validation. "arrays pass through" is
    // data-flow semantics, not test-execution semantics. The tightened
    // regex requires "pass(es)" to appear in a runtime context (subject
    // noun, "still"/"continues", clause boundary, or explicit phrase).
    makeTriageJson('t1', 'eval-t1', [
      'Nested objects and arrays pass through with their string children trimmed',
    ]);
    const r = instrument(root, [mkResult({ name: 't1' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('does NOT flag "pass through" / "passing through" / "passes through" idioms', () => {
    makeTriageJson('idioms', 'eval-idioms', [
      'data flows pass through the validator unchanged',
      'arguments and options pass through to the inner function',
      'the diff updates the function to pass through additional metadata',
      'when the wrapper passes through, the inner handler runs',
    ]);
    const r = instrument(root, [mkResult({ name: 'idioms' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('does NOT flag "passes X to Y" / "pass into" transitive uses', () => {
    makeTriageJson('transitive', 'eval-transitive', [
      'the function takes a callback and passes the result to the caller',
      'src/api.js parses the request and passes options into the handler',
      'the test fixture sends data and passes a config to the wrapper',
    ]);
    const r = instrument(root, [mkResult({ name: 'transitive' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('does NOT flag "passing" gerund (which the old regex ignored anyway, kept for completeness)', () => {
    makeTriageJson('gerund', 'eval-gerund', [
      'the diff adds error handling for the case where args are passing through unmodified',
    ]);
    const r = instrument(root, [mkResult({ name: 'gerund' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('detects clause-boundary runtime claim ("..., and Y passes.")', () => {
    makeTriageJson('clause', 'eval-clause', [
      'X is exported correctly, and Y passes.',
    ]);
    const r = instrument(root, [mkResult({ name: 'clause' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(1);
  });

  it('records the actual CHECKPOINT 3 round-2 failing criterion', () => {
    makeTriageJson('add-clamp', 'eval-add-clamp', [
      'test/math.test.js contains a test for the multiply function and it still passes',
    ]);
    const r = instrument(root, [mkResult({ name: 'add-clamp' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(1);
    expect(r.triageAntiPatternViolations[0]?.task).toBe('add-clamp');
  });

  it('aggregates violations across multiple tasks', () => {
    makeTriageJson('a', 'eval-a', [
      'src/foo.js exports parse and the tests pass',
    ]);
    makeTriageJson('b', 'eval-b', [
      'b is correct (no anti-pattern here)',
    ]);
    makeTriageJson('c', 'eval-c', [
      'test/c.test.js contains an assertion and it still passes',
      'src/c.js exports cFunc',
    ]);
    const r = instrument(root, [
      mkResult({ name: 'a' }),
      mkResult({ name: 'b' }),
      mkResult({ name: 'c' }),
    ]);
    expect(r.triageAntiPatternViolations).toHaveLength(2);
    expect(r.triageAntiPatternViolations.map((v) => v.task).sort()).toEqual(['a', 'c']);
  });

  it('skips tasks with no triage.json (triage-rejection or baseline mode)', () => {
    // task with no triage.json at all
    const r = instrument(root, [mkResult({ name: 'no-triage' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
  });

  it('skips triage-rejection results (ok:false specs)', () => {
    const dir = join(root, 'rejected', 'eval-rejected');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'triage.json'),
      JSON.stringify({
        schemaVersion: 1,
        result: { ok: false, reason: 'too_vague', message: 'x', usages: [] },
        durationMs: 100,
      }),
    );
    const r = instrument(root, [mkResult({ name: 'rejected' })]);
    expect(r.triageAntiPatternViolations).toHaveLength(0);
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
