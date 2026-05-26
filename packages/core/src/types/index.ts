/**
 * Core domain types for the agent loop.
 *
 * Design notes:
 * - All identifiers are branded strings to prevent mixing up RunId vs SpecId.
 * - Timestamps are ISO 8601 strings. We do not use Date objects in the core —
 *   they're mutable, locale-dependent, and a pain to serialize. Convert at the edges.
 * - All states are explicit. No booleans like `isComplete`. Use the discriminator.
 * - Phases are linear and named after what's *happening*, not what just finished.
 */

// --- Branded identifiers ---------------------------------------------------

declare const brand: unique symbol;
type Brand<T, B> = T & { [brand]: B };

export type RunId = Brand<string, 'RunId'>;
export type SpecId = Brand<string, 'SpecId'>;
export type TaskId = Brand<string, 'TaskId'>;

export const RunId = (s: string): RunId => s as RunId;
export const SpecId = (s: string): SpecId => s as SpecId;
export const TaskId = (s: string): TaskId => s as TaskId;

// --- Phases ----------------------------------------------------------------

/**
 * A Run moves through these phases in order. Each phase is a unit of work
 * that may succeed, fail, or be abandoned. The state machine transitions
 * between phases.
 *
 * - `queued`: Run exists, no work started yet.
 * - `triaging`: Converting raw task into a structured spec.
 * - `awaiting_spec_approval`: Spec produced, waiting for review (human or auto).
 * - `planning`: Producing an execution plan from the approved spec.
 * - `awaiting_plan_approval`: Plan produced, waiting for review.
 * - `executing`: Implementing the plan.
 * - `verifying`: Running tests, lint, typecheck, semantic verification.
 * - `opening_pr`: Creating the pull request.
 * - `done`: PR opened, run complete.
 * - `failed`: Terminal failure. See `failure` field for details.
 * - `abandoned`: Manually stopped. See `abandonedReason`.
 */
export type Phase =
  | 'queued'
  | 'triaging'
  | 'awaiting_spec_approval'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'executing'
  | 'verifying'
  | 'opening_pr'
  | 'done'
  | 'failed'
  | 'abandoned';

export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set([
  'done',
  'failed',
  'abandoned',
]);

export const isTerminal = (phase: Phase): boolean => TERMINAL_PHASES.has(phase);

// --- Failure --------------------------------------------------------------

/**
 * Failures are categorized. This matters because we'll want to retry some
 * categories automatically (transient) and never retry others (spec invalid).
 */
export type FailureCategory =
  | 'transient'           // network, rate limit, container crash — retry safe
  | 'spec_invalid'        // triage couldn't produce a valid spec
  | 'plan_rejected'       // plan check failed
  | 'execution_error'     // agent couldn't implement
  | 'verification_failed' // tests/lint/types didn't pass after N attempts
  | 'budget_exceeded'     // token, time, or attempt limit hit
  | 'internal';           // bug in the orchestrator itself

export interface Failure {
  category: FailureCategory;
  message: string;
  phase: Phase;
  /** Optional pointer into artifacts on disk for details. */
  artifactPath?: string;
}

// --- Token usage ----------------------------------------------------------

/**
 * Structured token usage for one LLM call (executor, triage, planner, etc).
 * Recorded in `record_token_usage` event payloads; the running sum lives on
 * `Run.tokensSpent` as a single number for budget comparisons. All four
 * token kinds are billable (cache reads at a lower rate), so the sum used
 * for budget checks includes all of them.
 *
 * Fields mirror what the Claude Code CLI's `--output-format json` emits;
 * `costUsd` is included when the source provides it.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUsd?: number;
}

// --- Run -------------------------------------------------------------------

/**
 * A Run is the unit of work. One Run = one task being processed by the loop.
 * The Run is the only mutable entity in the system; everything else
 * (specs, plans, verdicts) is immutable once written.
 */
export interface Run {
  id: RunId;
  taskId: TaskId;
  /** Path to the artifact directory: `runs/<id>/`. */
  artifactDir: string;
  /** Branch name for the worktree. */
  branch: string;
  phase: Phase;
  /** Set once triage produces a spec. */
  specId?: SpecId;
  /** Monotonic version, incremented on every transition. Used for optimistic locking. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Number of attempts in the current phase. Resets on phase change. */
  attemptCount: number;
  /** Total tokens spent across all phases of this run. */
  tokensSpent: number;
  /** Total wall-clock seconds spent in active work (not waiting). */
  secondsSpent: number;
  failure?: Failure;
  abandonedReason?: string;
  /** Set once the PR is opened (phase `done`). Persisted in the runs table. */
  prUrl?: string;
}

// --- Spec ------------------------------------------------------------------

/**
 * A Spec is the structured representation of what to do, produced by triage.
 * Immutable once approved. If you need to change it, create a new run.
 */
export interface Spec {
  id: SpecId;
  runId: RunId;
  /** One-line summary. */
  title: string;
  /** Full description, may be markdown. */
  description: string;
  /** Files the agent is allowed to touch. Glob patterns. */
  fileScope: string[];
  /** Concrete, testable acceptance criteria. */
  acceptanceCriteria: string[];
  /** Test commands to run for verification. */
  testCommands: string[];
  /** Hard limits for this run. */
  budget: Budget;
  createdAt: string;
}

export interface Budget {
  maxTokens: number;
  maxSeconds: number;
  maxAttemptsPerPhase: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxTokens: 500_000,
  maxSeconds: 1800, // 30 minutes
  maxAttemptsPerPhase: 5,
};

// --- Plan ------------------------------------------------------------------

/**
 * A Plan is the agent's stated approach before executing. Reviewing the plan
 * catches bad approaches before any code is written.
 */
export interface Plan {
  runId: RunId;
  specId: SpecId;
  /** Files the agent intends to create, modify, or delete. */
  filesToTouch: PlannedFileChange[];
  /** Free-form prose: what's the approach, what are the risks. */
  approach: string;
  /** Things that could go wrong. */
  risks: string[];
  /** How the agent intends to verify its own work before declaring done. */
  testStrategy: string;
  createdAt: string;
}

export interface PlannedFileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  reason: string;
}

// --- Verdict ---------------------------------------------------------------

/**
 * A Verdict is the verifier's independent judgment of the executor's output.
 * The executor does NOT get to decide success.
 */
export interface Verdict {
  runId: RunId;
  pass: boolean;
  /** Results of each test command from the spec. */
  testResults: TestResult[];
  /** LLM-based check: does the diff actually match the spec? */
  semanticCheck: {
    matches: boolean;
    reasoning: string;
    /**
     * Per-criterion judgment from the semantic verifier (Week 3+).
     * Absent when the verifier is the legacy exit-code-only path
     * or when an SDK error skipped the semantic step.
     */
    perCriterion?: PerCriterionJudgment[];
  };
  createdAt: string;
}

/**
 * One per-criterion judgment from the semantic verifier. The criterion
 * string is echoed verbatim from the spec's acceptanceCriteria; reasoning
 * is the verifier's evidence (typically a hunk citation or a "no hunks
 * touch path X" observation).
 */
export interface PerCriterionJudgment {
  criterion: string;
  met: boolean;
  reasoning: string;
}

export interface TestResult {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Truncated to first/last 4KB if larger; full output in artifacts. */
  outputSummary: string;
}

// --- Task ------------------------------------------------------------------

/**
 * A unit of inbound work from a TaskSource (GitHub issue, local file,
 * etc.). One Task → one Run. The Task is the durable record of the
 * external input; Run.taskId references it.
 *
 * The `id` is a structured branded string with a `source:` prefix —
 * `github:owner/repo#42`, `local:hardcoded`, `eval:add-clamp`. The
 * source's parsing surface is small (currently just the PR-linking
 * code), so the structure is honest about its meaning while still
 * keeping `TaskId` as a single opaque-to-consumers string.
 *
 * `sourceMetadata` is forward-compat: GitHub will store labels and
 * assignees here without requiring a schema migration. Optional and
 * untyped because each source defines its own shape; consumers that
 * care about a specific source narrow the type at their use site.
 */
export interface Task {
  id: TaskId;
  title: string;
  body: string;
  /** Stable id of the TaskSource (e.g., "github:owner/repo", "local"). */
  source: string;
  createdAt: string;
  /** External URL for backlinking from artifacts and PRs. */
  url?: string;
  /** Source-specific metadata: GitHub labels, assignees, etc. */
  sourceMetadata?: Record<string, unknown>;
}
