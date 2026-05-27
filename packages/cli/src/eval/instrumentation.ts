/**
 * CHECKPOINT 3 instrumentation. Three signals the user asked for in the
 * Phase E kickoff:
 *
 *   1. **Planner context-seeking rate.** Of all planner outputs, what
 *      fraction mention "need to see", "depends on", etc. in the
 *      approach or risks fields? This is the re-prioritization signal
 *      for gap-triage-thin-context in BACKLOG.md.
 *
 *   2. **Per-phase cost breakdown** for at least one passing task.
 *      Validates the planner cost model from Week 3 plan §C4.
 *
 *   3. **Plan-quality mismatch** detection. A run that produced a plan
 *      but failed in a later phase (executor or verifier). Plan quality
 *      issues are easier to fix when they're surfaced explicitly.
 *
 * All three are read post-hoc from the artifact JSON files written by
 * tickPlanning + tick.ts in general — no runtime instrumentation
 * needed, just disk scanning.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase } from '@agent-loop/core';
import type { EvalTaskResult, PhaseMetrics } from './types.js';

/**
 * Phrases that signal the planner wished it had more context. Used in
 * substring matches against `plan.approach + plan.risks.join(' ')`,
 * case-insensitive.
 */
const CONTEXT_SEEKING_PHRASES = [
  'need to see',
  'need to view',
  'without seeing',
  'cannot tell',
  "can't tell",
  "can't determine",
  'cannot determine',
  'unclear from',
  'more context',
  'more information',
  'depends on',
  'would need to',
  'ambiguous',
  'not clear from',
] as const;

/**
 * Detects the compound runtime-claim anti-pattern in triage's
 * acceptanceCriteria output. Matches a conjunction word followed by
 * up to 60 characters followed by a runtime-claim assertion.
 *
 * The earlier (initial) version of this regex matched bare "pass" /
 * "passes" anywhere in the tail. That over-matched idiomatic uses:
 * "Nested objects and arrays pass through ..." flagged a false
 * positive because "and arrays" matched the conjunction and "pass"
 * the runtime keyword, even though "pass through" is data-flow
 * semantics, not test-execution. See the CHECKPOINT 3 round-2 round
 * for the original data point.
 *
 * Tightened: "pass(es)" must appear in one of four runtime contexts:
 *   1. After a runtime SUBJECT noun (tests/build/spec/suite/verification/
 *      assertion). "the new tests pass" → matches.
 *   2. After "still" / "continue(s) to". "it still passes" → matches.
 *   3. At a clause boundary (followed by punctuation or end of string).
 *      "X is correct, and Y passes." → matches.
 *   4. Explicit phrases: "build succeeds", "no regressions", "works
 *      correctly", "runs correctly".
 *
 * Examples that match:
 *   - "X exists and it still passes"
 *   - "Y remains unchanged and continues to pass"
 *   - "Z is correct, plus the new tests pass"
 *   - "code is right and the build succeeds"
 *
 * Examples that do NOT match:
 *   - "Nested objects and arrays pass through ..." (idiom: pass through)
 *   - "X passes value to Y" (transitive verb, not test execution)
 *   - "code is right and Y exists" (no runtime keyword)
 *   - "passes the test for X" (no preceding conjunction)
 */
export const COMPOUND_RUNTIME_CLAIM_REGEX = new RegExp(
  // Conjunction word
  '\\b(?:and|also|plus|while|moreover)\\s+' +
    // Up to 60 chars between conjunction and the runtime claim
    '.{0,60}' +
    // Runtime claim — one of four shapes:
    '(?:' +
    // (1) runtime subject + (optional "still"/"continues to") + verb
    '\\b(?:tests?|build|spec|suite|verification|assertion[s]?)\\s+(?:still\\s+|continues?\\s+to\\s+)?(?:pass(?:es)?|succeed[s]?)\\b' +
    '|' +
    // (2) "still passes" / "continues to pass" — implicit runtime subject
    '\\b(?:still|continues?\\s+to|continue\\s+to)\\s+pass(?:es)?\\b' +
    '|' +
    // (3) standalone "passes" / "pass" at clause boundary — but NOT
    // followed by "through" (the "pass through" idiom is data-flow
    // semantics, not test-execution, and it became more common in
    // criteria after the 2026-05-27 task.md tightening of
    // infer-target-file added "pass through unchanged" phrasing).
    '\\bpass(?:es)?(?!\\s+through)(?=\\s*(?:[,.;!?]|$))' +
    '|' +
    // (4) explicit runtime phrases
    '\\bbuild\\s+succeeds?\\b' +
    '|' +
    '\\bno\\s+regressions?\\b' +
    '|' +
    '\\bworks?\\s+correctly\\b' +
    '|' +
    '\\bruns?\\s+correctly\\b' +
    ')',
  'i',
);

export interface PlannerSignals {
  /** Tasks where a planner.json artifact was found. */
  withPlannerOutput: number;
  /** Subset where the planner's approach/risks contained context-seeking language. */
  contextSeekingCount: number;
  /** contextSeekingCount / withPlannerOutput, or 0 when denominator is 0. */
  contextSeekingRate: number;
  /** Per-task: did the planner output exhibit context-seeking? Only tasks with a planner.json appear. */
  perTask: Array<{ name: string; contextSeeking: boolean; matchedPhrases: string[] }>;
}

export interface PlanQualityMismatch {
  name: string;
  /** The phase where the run actually failed. */
  failedPhase: Phase;
  /** Failure category from Run.failure. */
  failureCategory: string;
}

/**
 * A compound runtime-claim shape detected in triage's acceptanceCriteria.
 * One entry per offending criterion (a task can have multiple).
 */
export interface TriageAntiPatternViolation {
  /** Eval task name. */
  task: string;
  /** Index into the spec's acceptanceCriteria array (0-based). */
  criterionIndex: number;
  /** The offending criterion text, verbatim. */
  criterion: string;
}

export interface InstrumentationResult {
  plannerSignals: PlannerSignals;
  planQualityMismatches: PlanQualityMismatch[];
  triageAntiPatternViolations: TriageAntiPatternViolation[];
}

/**
 * Scan a results directory and the per-task results to compute the
 * CHECKPOINT 3 signals. Reads `<resultsDir>/<task>/<runId>/planner.json`
 * for each task; skips silently when the file is absent (baseline runs,
 * triage-rejected runs).
 */
export function instrument(
  resultsDir: string,
  perTask: ReadonlyArray<EvalTaskResult>,
): InstrumentationResult {
  const plannerSignals: PlannerSignals = {
    withPlannerOutput: 0,
    contextSeekingCount: 0,
    contextSeekingRate: 0,
    perTask: [],
  };
  const planQualityMismatches: PlanQualityMismatch[] = [];
  const triageAntiPatternViolations: TriageAntiPatternViolation[] = [];

  for (const t of perTask) {
    const taskDir = join(resultsDir, t.name);
    const plannerFile = findPlannerJson(taskDir);
    if (plannerFile) {
      const analysis = analyzePlannerFile(plannerFile);
      if (analysis !== null) {
        plannerSignals.withPlannerOutput += 1;
        if (analysis.matched.length > 0) {
          plannerSignals.contextSeekingCount += 1;
        }
        plannerSignals.perTask.push({
          name: t.name,
          contextSeeking: analysis.matched.length > 0,
          matchedPhrases: analysis.matched,
        });
      }
    }

    // Plan-quality mismatch: a run that REACHED the executing phase
    // (which means triage + planner both succeeded) but ended in a
    // failure phase. We check via the per-phase metrics: an executing
    // entry with non-zero duration is the proxy for "executor ran".
    const planningDuration = t.perPhase['planning']?.durationMs ?? 0;
    const reachedExecutor = (t.perPhase['executing']?.durationMs ?? 0) > 0;
    const failed = !t.passed && t.phase === 'failed';
    if (failed && planningDuration > 0 && reachedExecutor && t.failure) {
      planQualityMismatches.push({
        name: t.name,
        failedPhase: t.failure.phase,
        failureCategory: t.failure.category,
      });
    }

    // Triage anti-pattern meta-test: scan acceptanceCriteria for
    // compound runtime claims. The triage system prompt's anti-pattern
    // section forbids these; this meta-test catches leaks. Surfacing
    // violations decouples "the verifier got lucky" from "triage
    // produced clean output" — see CHECKPOINT 3 round 2 retro.
    const triageFile = findTriageJson(taskDir);
    if (triageFile) {
      const criteria = extractAcceptanceCriteria(triageFile);
      for (let i = 0; i < criteria.length; i++) {
        const criterion = criteria[i]!;
        if (COMPOUND_RUNTIME_CLAIM_REGEX.test(criterion)) {
          triageAntiPatternViolations.push({
            task: t.name,
            criterionIndex: i,
            criterion,
          });
        }
      }
    }
  }

  plannerSignals.contextSeekingRate =
    plannerSignals.withPlannerOutput === 0
      ? 0
      : plannerSignals.contextSeekingCount / plannerSignals.withPlannerOutput;

  return { plannerSignals, planQualityMismatches, triageAntiPatternViolations };
}

/**
 * Format a per-phase cost breakdown for one task as a markdown block.
 * Used in the report.md to validate the planner cost model from §C4.
 */
export function formatPerPhaseCost(task: EvalTaskResult): string {
  const lines: string[] = [];
  lines.push(`### Per-phase cost breakdown: \`${task.name}\``);
  lines.push('');
  lines.push('| Phase | Duration | Tokens | Cost (USD) |');
  lines.push('|---|---|---|---|');
  const phasesInOrder: Phase[] = [
    'triaging',
    'awaiting_spec_approval',
    'planning',
    'awaiting_plan_approval',
    'executing',
    'verifying',
    'opening_pr',
  ];
  for (const phase of phasesInOrder) {
    const m = task.perPhase[phase];
    if (!m) continue;
    const dur = `${(m.durationMs / 1000).toFixed(1)}s`;
    const cost = `$${m.costUsd.toFixed(4)}`;
    lines.push(`| ${phase} | ${dur} | ${m.tokensSpent} | ${cost} |`);
  }
  return lines.join('\n');
}

// --- internals -----------------------------------------------------------

function findPlannerJson(taskDir: string): string | null {
  if (!existsSync(taskDir)) return null;
  // Layout: <taskDir>/<runId>/planner.json
  try {
    for (const child of readdirSync(taskDir)) {
      const candidate = join(taskDir, child, 'planner.json');
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface PlannerAnalysis {
  matched: string[];
}

function analyzePlannerFile(path: string): PlannerAnalysis | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const result = raw['result'];
  if (!isRecord(result)) return null;
  if (result['ok'] !== true) {
    // Planner rejected; no plan to analyze — not "context-seeking" in the
    // sense we care about. Still counts as "had a planner output".
    return { matched: [] };
  }
  const plan = result['plan'];
  if (!isRecord(plan)) return { matched: [] };
  const approach = typeof plan['approach'] === 'string' ? plan['approach'] : '';
  const risks = Array.isArray(plan['risks'])
    ? plan['risks'].filter((s): s is string => typeof s === 'string').join(' ')
    : '';
  const haystack = `${approach}\n${risks}`.toLowerCase();
  const matched: string[] = [];
  for (const phrase of CONTEXT_SEEKING_PHRASES) {
    if (haystack.includes(phrase)) matched.push(phrase);
  }
  return { matched };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function findTriageJson(taskDir: string): string | null {
  if (!existsSync(taskDir)) return null;
  try {
    for (const child of readdirSync(taskDir)) {
      const candidate = join(taskDir, child, 'triage.json');
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Pull `acceptanceCriteria` (array of strings) from a triage.json file.
 * Returns [] for triage-rejection cases (no spec produced) and on any
 * parse/shape error — the meta-test then trivially passes for that task,
 * which is the conservative behavior.
 */
function extractAcceptanceCriteria(path: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(raw)) return [];
  const result = raw['result'];
  if (!isRecord(result) || result['ok'] !== true) return [];
  const spec = result['spec'];
  if (!isRecord(spec)) return [];
  const criteria = spec['acceptanceCriteria'];
  if (!Array.isArray(criteria)) return [];
  return criteria.filter((c): c is string => typeof c === 'string');
}
