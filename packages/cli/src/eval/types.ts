/**
 * Shared types for the eval harness.
 */

import type { Phase, Failure } from '@agent-loop/core';

export interface EvalExpected {
  acceptanceCriteria: string[];
  testCommands: string[];
}

export interface EvalTask {
  /** Directory name under evals/tasks/, used as a stable id. */
  name: string;
  /** Absolute path to the task's root directory. */
  rootPath: string;
  /** Absolute path to the task's base/ (starting repo state). */
  basePath: string;
  /** Full text of task.md (the prose input to triage). */
  taskMd: string;
  expected: EvalExpected;
}

export interface PhaseMetrics {
  /** Wall-clock duration in this phase, measured from the entering event
   *  timestamp to the leaving event timestamp. May be 0 if both happened
   *  within the same logical instant (test stubs, no-op phases). */
  durationMs: number;
  /** Sum of `tokens` operand on record_token_usage events emitted in this phase. */
  tokensSpent: number;
  /** Sum of cost on usage payloads emitted in this phase (when present). */
  costUsd: number;
  /** Sum of cache-read tokens from usage payloads (for cache hit rate). */
  cacheReadTokens: number;
  /** Sum of input + cacheRead + cacheCreation across all events in this phase. */
  totalInputTokens: number;
}

export interface EvalTaskResult {
  name: string;
  passed: boolean;
  phase: Phase;
  runId: string;
  /** Whole-run wall clock from the first to the last event. */
  durationMs: number;
  /** Aggregated across all phases. */
  tokensSpent: number;
  costUsd: number;
  /** cacheReadTokens / max(1, totalInputTokens). */
  cacheHitRate: number;
  /** Per-phase breakdown; only phases that produced events appear. */
  perPhase: Partial<Record<Phase, PhaseMetrics>>;
  /** Failure context if the run did not reach done. */
  failure: Failure | null;
}

export interface EvalSummary {
  timestamp: string;
  gitHead: string;
  totalTasks: number;
  passed: number;
  passRate: number;
  perTask: EvalTaskResult[];
  aggregates: {
    p50DurationMs: number;
    p95DurationMs: number;
    p50CostUsd: number;
    p95CostUsd: number;
    medianCostUsd: number;
    p50CacheHitRate: number;
  };
}
