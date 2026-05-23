/**
 * Row converters — the one place where snake_case rows become camelCase
 * domain objects and back. Pure functions, no I/O.
 *
 * Rules:
 * - On read: NULL columns map to absent properties (matches
 *   exactOptionalPropertyTypes). Never set `foo: undefined` on the result.
 * - On write: undefined optionals become `null` (better-sqlite3 won't bind
 *   undefined). JSON blobs serialize with `JSON.stringify`.
 * - We trust the DB. A phase string read back is cast to Phase; if anyone
 *   ever corrupts the column, the state machine will catch it downstream.
 */

import {
  type Run,
  type Spec,
  type Plan,
  type Verdict,
  type Failure,
  type Budget,
  type PlannedFileChange,
  type TestResult,
  type Phase,
  type Event,
  RunId,
  SpecId,
  TaskId,
} from '@agent-loop/core';

// --- Runs ------------------------------------------------------------------

export interface RunRow {
  id: string;
  task_id: string;
  artifact_dir: string;
  branch: string;
  phase: string;
  spec_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  tokens_spent: number;
  seconds_spent: number;
  failure_json: string | null;
  abandoned_reason: string | null;
  pr_url: string | null;
}

export function rowToRun(row: RunRow): Run {
  const run: Run = {
    id: RunId(row.id),
    taskId: TaskId(row.task_id),
    artifactDir: row.artifact_dir,
    branch: row.branch,
    phase: row.phase as Phase,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attemptCount: row.attempt_count,
    tokensSpent: row.tokens_spent,
    secondsSpent: row.seconds_spent,
  };
  if (row.spec_id !== null) run.specId = SpecId(row.spec_id);
  if (row.failure_json !== null) {
    run.failure = JSON.parse(row.failure_json) as Failure;
  }
  if (row.abandoned_reason !== null) run.abandonedReason = row.abandoned_reason;
  if (row.pr_url !== null) run.prUrl = row.pr_url;
  return run;
}

export function runToParams(run: Run): RunRow {
  return {
    id: run.id,
    task_id: run.taskId,
    artifact_dir: run.artifactDir,
    branch: run.branch,
    phase: run.phase,
    spec_id: run.specId ?? null,
    version: run.version,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    attempt_count: run.attemptCount,
    tokens_spent: run.tokensSpent,
    seconds_spent: run.secondsSpent,
    failure_json: run.failure ? JSON.stringify(run.failure) : null,
    abandoned_reason: run.abandonedReason ?? null,
    pr_url: run.prUrl ?? null,
  };
}

// --- Specs -----------------------------------------------------------------

export interface SpecRow {
  id: string;
  run_id: string;
  title: string;
  description: string;
  file_scope_json: string;
  acceptance_json: string;
  test_commands_json: string;
  budget_json: string;
  created_at: string;
}

export function rowToSpec(row: SpecRow): Spec {
  return {
    id: SpecId(row.id),
    runId: RunId(row.run_id),
    title: row.title,
    description: row.description,
    fileScope: JSON.parse(row.file_scope_json) as string[],
    acceptanceCriteria: JSON.parse(row.acceptance_json) as string[],
    testCommands: JSON.parse(row.test_commands_json) as string[],
    budget: JSON.parse(row.budget_json) as Budget,
    createdAt: row.created_at,
  };
}

export function specToParams(spec: Spec): SpecRow {
  return {
    id: spec.id,
    run_id: spec.runId,
    title: spec.title,
    description: spec.description,
    file_scope_json: JSON.stringify(spec.fileScope),
    acceptance_json: JSON.stringify(spec.acceptanceCriteria),
    test_commands_json: JSON.stringify(spec.testCommands),
    budget_json: JSON.stringify(spec.budget),
    created_at: spec.createdAt,
  };
}

// --- Plans -----------------------------------------------------------------

export interface PlanRow {
  run_id: string;
  spec_id: string;
  files_to_touch_json: string;
  approach: string;
  risks_json: string;
  test_strategy: string;
  created_at: string;
}

export function rowToPlan(row: PlanRow): Plan {
  return {
    runId: RunId(row.run_id),
    specId: SpecId(row.spec_id),
    filesToTouch: JSON.parse(row.files_to_touch_json) as PlannedFileChange[],
    approach: row.approach,
    risks: JSON.parse(row.risks_json) as string[],
    testStrategy: row.test_strategy,
    createdAt: row.created_at,
  };
}

export function planToParams(plan: Plan): PlanRow {
  return {
    run_id: plan.runId,
    spec_id: plan.specId,
    files_to_touch_json: JSON.stringify(plan.filesToTouch),
    approach: plan.approach,
    risks_json: JSON.stringify(plan.risks),
    test_strategy: plan.testStrategy,
    created_at: plan.createdAt,
  };
}

// --- Verdicts --------------------------------------------------------------

/**
 * The DB has an internal autoincrement `id` for ordering verdicts when
 * multiple appear per run (week 3+). The domain `Verdict` type has no id;
 * the row converter drops it on read and omits it on write.
 */
export interface VerdictRow {
  id: number;
  run_id: string;
  pass: number; // 0 or 1; SQLite has no boolean
  test_results_json: string;
  semantic_check_json: string;
  created_at: string;
}

export interface VerdictInsertParams {
  run_id: string;
  pass: number;
  test_results_json: string;
  semantic_check_json: string;
  created_at: string;
}

export function rowToVerdict(row: VerdictRow): Verdict {
  return {
    runId: RunId(row.run_id),
    pass: row.pass === 1,
    testResults: JSON.parse(row.test_results_json) as TestResult[],
    semanticCheck: JSON.parse(row.semantic_check_json) as {
      matches: boolean;
      reasoning: string;
    },
    createdAt: row.created_at,
  };
}

export function verdictToParams(verdict: Verdict): VerdictInsertParams {
  return {
    run_id: verdict.runId,
    pass: verdict.pass ? 1 : 0,
    test_results_json: JSON.stringify(verdict.testResults),
    semantic_check_json: JSON.stringify(verdict.semanticCheck),
    created_at: verdict.createdAt,
  };
}

// --- Events ----------------------------------------------------------------

/**
 * Event payload is the entire Event object serialized as JSON. The
 * `event_type` column is denormalized for filtering/inspection but the
 * source of truth is the payload.
 */
export interface EventRow {
  id: number;
  run_id: string;
  event_type: string;
  payload: string;
  applied_at: string;
  run_version_after: number;
}

export interface EventInsertParams {
  run_id: string;
  event_type: string;
  payload: string;
  applied_at: string;
  run_version_after: number;
}

export interface EventRecord {
  id: number;
  runId: RunId;
  event: Event;
  appliedAt: string;
  runVersionAfter: number;
}

export function rowToEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    runId: RunId(row.run_id),
    event: JSON.parse(row.payload) as Event,
    appliedAt: row.applied_at,
    runVersionAfter: row.run_version_after,
  };
}

export function eventToParams(
  runId: string,
  event: Event,
  runVersionAfter: number,
  appliedAt: string,
): EventInsertParams {
  return {
    run_id: runId,
    event_type: event.type,
    payload: JSON.stringify(event),
    applied_at: appliedAt,
    run_version_after: runVersionAfter,
  };
}
