/**
 * tick(deps, run): performs one phase's I/O work and applies the resulting
 * event. The single unit of progress in the orchestrator loop.
 *
 * RULE — the STOP file is checked exactly once, at the top of tick(),
 * before any phase work begins. Once a phase starts, it runs to completion.
 * Halting mid-phase would risk corrupted artifacts, orphan worktrees, and
 * partially-applied events. Subprocess termination during shutdown is a
 * separate concern (proc/run.ts AbortSignal), not the STOP file.
 *
 * Week 2 only auto-drives three phases:
 *   - executing  → ensure worktree, run the agent, apply succeeded/failed
 *   - verifying  → run the verifier, persist verdict, apply succeeded/failed
 *   - opening_pr → run the PR opener, apply pr_opened/pr_failed
 *
 * Triage/spec-approval/planning/plan-approval phases are CLI-driven for
 * week 2 (no triage or planner agents exist yet). tick() is a no-op in
 * those phases — they advance when the human (or future agent) applies the
 * corresponding event through the CLI.
 *
 * All Run state mutations go through applyEvent. The Verdict is persisted
 * separately via store.insertVerdict because it is not part of the Run.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Logger,
  type Run,
  type Spec,
  type Verdict,
  type Failure,
  type FailureCategory,
  DEFAULT_BUDGET,
  SpecId,
  isTerminal,
} from '@agent-loop/core';
import type { Store } from '../db/store.js';
import type { Executor } from '../executor/types.js';
import type { PrOpener } from '../pr/types.js';
import type { VerifyOptions } from '../verifier/index.js';
import { addWorktree, removeWorktree } from '../git/worktree.js';
import { isStopRequested } from '../fs/stop.js';
import { runCommand } from '../proc/run.js';
import { sumTokens } from '../executor/claudeOutput.js';
import {
  writeExecutorArtifacts,
  writeVerdictArtifact,
  writeTriageArtifact,
  writePlannerArtifact,
  writePlanArtifact,
} from '../artifacts/write.js';
import type { AnthropicClient } from '../agents/sdkClient.js';
import {
  runTriage,
  type TriageDeps,
  type TriageInput,
} from '../agents/triage.js';
import type { TriageRejectionReason } from '../agents/triageSchema.js';
import {
  runPlanner,
  type PlannerDeps,
  type PlannerInput,
} from '../agents/planner.js';
import type { PlannerRejectionReason } from '../agents/plannerSchema.js';
import { applyEvent } from './apply.js';

export type Verifier = (
  run: Run,
  spec: Spec,
  options: VerifyOptions,
) => Promise<Verdict>;

export interface Deps {
  store: Store;
  logger: Logger;
  /** Where the STOP file lives; the orchestrator's "home". */
  workspaceDir: string;
  /** Where worktrees live: `<worktreesDir>/<run_id>/worktree`. */
  worktreesDir: string;
  /** Where artifact directories live: `<artifactsDir>/<run_id>/`. */
  artifactsDir: string;
  /** Target repo (the codebase the agent is editing). */
  repoDir: string;
  now: () => string;
  executor: Executor;
  verifier: Verifier;
  prOpener: PrOpener;
  /**
   * Anthropic SDK client. Required when a Run will pass through the
   * `triaging` phase (Phase D+). The baseline eval runner skips
   * triaging via `driveToExecuting` and can omit this.
   */
  anthropicClient?: AnthropicClient;
}

export async function tick(deps: Deps, run: Run): Promise<Run> {
  if (isStopRequested(deps.workspaceDir)) {
    deps.logger.info('tick: STOP requested; halting', { runId: run.id });
    return run;
  }
  if (isTerminal(run.phase)) return run;

  switch (run.phase) {
    case 'triaging':
      return tickTriaging(deps, run);
    case 'awaiting_spec_approval':
      // Auto-approve in week 3 (no human-approval mechanism yet). Will gain
      // an opt-out when human review lands.
      return applyEvent(
        deps.store,
        run.id,
        { type: 'spec_approved' },
        deps.now(),
      );
    case 'planning':
      return tickPlanning(deps, run);
    case 'awaiting_plan_approval':
      // Same auto-approval pattern as awaiting_spec_approval.
      return applyEvent(
        deps.store,
        run.id,
        { type: 'plan_approved' },
        deps.now(),
      );
    case 'executing':
      return tickExecuting(deps, run);
    case 'verifying':
      return tickVerifying(deps, run);
    case 'opening_pr':
      return tickOpeningPr(deps, run);
    default:
      deps.logger.debug('tick: phase not auto-driven (CLI/manual)', {
        runId: run.id,
        phase: run.phase,
      });
      return run;
  }
}

// --- Phase handlers --------------------------------------------------------

async function tickExecuting(deps: Deps, run: Run): Promise<Run> {
  const spec = deps.store.getSpecByRun(run.id);
  if (!spec) {
    return failExecution(deps, run, {
      category: 'internal',
      message: 'no spec found for run in executing phase',
    });
  }

  const worktreePath = worktreePathFor(deps, run.id);
  // Lazy creation. Existing worktree on disk (e.g., after an orchestrator
  // crash + restart) is reused — addWorktree's loud-fail is bypassed
  // intentionally here because re-entering a phase on the same run id
  // means the prior tick already created this path. If the directory is
  // corrupt, the agent run will fail and we'll see it in the executor logs.
  if (!existsSync(worktreePath)) {
    try {
      await addWorktree(deps.repoDir, run.branch, worktreePath);
    } catch (err) {
      return failExecution(deps, run, {
        category: 'internal',
        message: `worktree setup failed: ${String(err)}`,
      });
    }
  }

  // Lazy artifacts dir.
  const runArtifactDir = join(deps.artifactsDir, run.id);
  mkdirSync(runArtifactDir, { recursive: true });

  const result = await deps.executor.execute({
    run,
    spec,
    worktreePath,
    logger: deps.logger,
  });

  // Persist the agent's full transcript to disk. Done regardless of ok —
  // failed runs are the ones we most need to post-mortem.
  writeExecutorArtifacts(runArtifactDir, result);

  // Record token usage and wall-clock against the Run, regardless of ok —
  // a failed agent run still consumed tokens, and we want those reflected
  // in the budget and the audit trail.
  //
  // BUDGET ENFORCEMENT NOTE: token-budget checks below are post-call, not
  // mid-call. We catch a run that EXCEEDED budget only after the agent
  // finished its current invocation; we cannot interrupt the agent during
  // a tool call. The mid-call brake is spec.budget.maxSeconds (subprocess
  // wall-clock timeout in proc/run.ts). Tighter mid-call enforcement would
  // require agent-level cooperation (e.g., a periodic check tool the agent
  // calls between turns) — deferred until that pattern matters.
  if (result.usage) {
    applyEvent(
      deps.store,
      run.id,
      {
        type: 'record_token_usage',
        tokens: sumTokens(result.usage),
        usage: result.usage,
      },
      deps.now(),
    );
  }
  // Skip recording time when it rounds to 0 seconds (sub-500ms runs are
  // typically test stubs; emitting an event for them just pollutes the
  // audit log). Real runs are seconds to minutes long.
  const secondsToRecord = Math.round(result.durationMs / 1000);
  if (secondsToRecord > 0) {
    applyEvent(
      deps.store,
      run.id,
      { type: 'record_time_spent', seconds: secondsToRecord },
      deps.now(),
    );
  }

  // Budget check. See BUDGET ENFORCEMENT NOTE above for the mid-call
  // limitation. Done after recording tokens so the check sees the running
  // sum, including this phase's contribution.
  const afterRecord = deps.store.getRun(run.id)!;
  if (checkTokenBudget(deps, afterRecord, spec)) {
    return applyEvent(
      deps.store,
      run.id,
      {
        type: 'execution_failed',
        failure: {
          category: 'budget_exceeded',
          message: `token budget exceeded: ${afterRecord.tokensSpent} > ${spec.budget.maxTokens}`,
        },
      },
      deps.now(),
    );
  }

  if (result.ok) {
    // Agents edit files but don't commit them. The PR opener needs commits
    // to exist on the branch, so we commit on the agent's behalf here. If
    // the agent produced no changes, treat that as an execution_error —
    // an empty PR is not a success.
    const commit = await commitAgentChanges(deps, run, spec, worktreePath);
    if (!commit.ok) {
      return failExecution(deps, run, {
        category: 'execution_error',
        message: commit.error,
      });
    }
    return applyEvent(
      deps.store,
      run.id,
      { type: 'execution_succeeded' },
      deps.now(),
    );
  }

  const failure: Omit<Failure, 'phase'> = {
    category: result.timedOut ? 'budget_exceeded' : 'execution_error',
    message: result.timedOut
      ? `execution timed out after ${result.durationMs}ms`
      : `executor exited ${result.exitCode}`,
  };
  return applyEvent(
    deps.store,
    run.id,
    { type: 'execution_failed', failure },
    deps.now(),
  );
}

async function tickVerifying(deps: Deps, run: Run): Promise<Run> {
  const spec = deps.store.getSpecByRun(run.id);
  if (!spec) {
    return applyEvent(
      deps.store,
      run.id,
      {
        type: 'verification_failed',
        failure: {
          category: 'internal',
          message: 'no spec found for run in verifying phase',
        },
      },
      deps.now(),
    );
  }

  const worktreePath = worktreePathFor(deps, run.id);
  const verdict = await deps.verifier(run, spec, {
    cwd: worktreePath,
    logger: deps.logger,
    now: deps.now,
  });

  deps.store.insertVerdict(verdict);
  // Persist the verdict alongside the executor transcript. Index = current
  // count after insert (1-based) so the first verdict is verdict-001.
  const verdictIndex = deps.store.listVerdicts(run.id).length;
  writeVerdictArtifact(join(deps.artifactsDir, run.id), verdict, verdictIndex);

  if (verdict.pass) {
    return applyEvent(
      deps.store,
      run.id,
      { type: 'verification_succeeded' },
      deps.now(),
    );
  }
  return applyEvent(
    deps.store,
    run.id,
    {
      type: 'verification_failed',
      failure: {
        category: 'verification_failed',
        message: 'one or more test commands did not exit 0',
      },
    },
    deps.now(),
  );
}

async function tickOpeningPr(deps: Deps, run: Run): Promise<Run> {
  const spec = deps.store.getSpecByRun(run.id);
  if (!spec) {
    return failPr(deps, run, 'no spec found for run in opening_pr phase');
  }
  const verdicts = deps.store.listVerdicts(run.id);
  const latestVerdict = verdicts[verdicts.length - 1];
  if (!latestVerdict || !latestVerdict.pass) {
    return failPr(
      deps,
      run,
      'no passing verdict recorded — opening_pr requires a passing verification',
    );
  }

  const worktreePath = worktreePathFor(deps, run.id);
  const result = await deps.prOpener.openPullRequest({
    run,
    spec,
    verdict: latestVerdict,
    worktreePath,
    logger: deps.logger,
  });

  if (result.ok) {
    const next = applyEvent(
      deps.store,
      run.id,
      { type: 'pr_opened', url: result.url },
      deps.now(),
    );
    // Auto-cleanup on done. Successful runs no longer need their worktree —
    // the agent's commits live on the branch (locally and on the remote),
    // and the PR is the inspection surface. Failed and abandoned runs are
    // explicitly NOT cleaned here (they're exactly the runs whose worktree
    // a human will want to inspect). The gc subcommand handles the rest.
    //
    // Cleanup failure must NOT flip the run back from done to failed; the
    // PR exists on GitHub, so the run is genuinely done. Log a warn and
    // leave the orphan worktree for gc to sweep up.
    try {
      await removeWorktree(deps.repoDir, worktreePath);
      deps.logger.info('cleanup: worktree removed', {
        runId: run.id,
        path: worktreePath,
      });
    } catch (err) {
      deps.logger.warn('cleanup: removeWorktree failed (run remains done)', {
        runId: run.id,
        path: worktreePath,
        err: String(err),
      });
    }
    return next;
  }
  return failPr(deps, run, result.error);
}

// --- Helpers ---------------------------------------------------------------

function worktreePathFor(deps: Deps, runId: Run['id']): string {
  return join(deps.worktreesDir, runId, 'worktree');
}

// --- Triaging ---------------------------------------------------------------

async function tickTriaging(deps: Deps, run: Run): Promise<Run> {
  if (!deps.anthropicClient) {
    // The Run reached `triaging` but no SDK client is configured. This is
    // a wiring bug at the call site (start.ts or eval runner) — fail the
    // run loudly so it surfaces rather than infinite-loop on a no-op tick.
    return applyEvent(
      deps.store,
      run.id,
      {
        type: 'triage_failed',
        failure: {
          category: 'internal',
          message:
            'tickTriaging called but Deps.anthropicClient is not configured',
        },
      },
      deps.now(),
    );
  }

  const task = deps.store.getTask(run.taskId);
  if (!task) {
    return applyEvent(
      deps.store,
      run.id,
      {
        type: 'triage_failed',
        failure: {
          category: 'internal',
          message: `no task found for taskId ${run.taskId}`,
        },
      },
      deps.now(),
    );
  }

  const triageDeps: TriageDeps = {
    client: deps.anthropicClient,
    store: deps.store,
    runId: run.id,
    now: deps.now,
    logger: deps.logger,
  };
  const triageInput: TriageInput = {
    taskDescription: task.body,
    targetRepoPath: deps.repoDir,
  };
  if (task.title.length > 0) triageInput.taskTitle = task.title;

  const triageStart = Date.now();
  const result = await runTriage(triageDeps, triageInput);
  const triageDuration = Date.now() - triageStart;

  // Persist the full triage result regardless of outcome — the rejection
  // payload (with clarifyingQuestions) is exactly what we want to read
  // when diagnosing why a run failed at triage.
  const runArtifactDir = join(deps.artifactsDir, run.id);
  writeTriageArtifact(runArtifactDir, result, triageDuration);

  if (result.ok) {
    const specId = SpecId(`spec-${run.id}`);
    deps.store.insertSpec({
      id: specId,
      runId: run.id,
      title: result.spec.title,
      description: result.spec.description,
      fileScope: result.spec.fileScope,
      acceptanceCriteria: result.spec.acceptanceCriteria,
      testCommands: result.spec.testCommands,
      // Orchestrator owns the budget — we don't trust the model to size it.
      budget: DEFAULT_BUDGET,
      createdAt: deps.now(),
    });
    return applyEvent(
      deps.store,
      run.id,
      { type: 'triage_succeeded', specId },
      deps.now(),
    );
  }

  // Rejection path. Map the agent's rejection reason to a state-machine
  // failure category. The `clarifyingQuestions` are appended to the message
  // for now — Phase F's GitHub source will post them as an issue comment.
  const failureMessage =
    result.clarifyingQuestions && result.clarifyingQuestions.length > 0
      ? `${result.message}\n\nClarifying questions:\n${result.clarifyingQuestions.map((q) => `- ${q}`).join('\n')}`
      : result.message;
  return applyEvent(
    deps.store,
    run.id,
    {
      type: 'triage_failed',
      failure: {
        category: mapTriageRejectionToCategory(result.reason),
        message: failureMessage,
      },
    },
    deps.now(),
  );
}

function mapTriageRejectionToCategory(
  reason: TriageRejectionReason,
): FailureCategory {
  switch (reason) {
    case 'not_actionable':
    case 'too_vague':
    case 'out_of_scope':
    case 'invalid_output':
      return 'spec_invalid';
    case 'sdk_error':
      return 'transient';
  }
}

// --- Planning -------------------------------------------------------------

async function tickPlanning(deps: Deps, run: Run): Promise<Run> {
  if (!deps.anthropicClient) {
    return applyEvent(
      deps.store,
      run.id,
      {
        type: 'planning_failed',
        failure: {
          category: 'internal',
          message:
            'tickPlanning called but Deps.anthropicClient is not configured',
        },
      },
      deps.now(),
    );
  }
  if (!run.specId) {
    return applyEvent(
      deps.store,
      run.id,
      {
        type: 'planning_failed',
        failure: {
          category: 'internal',
          message: 'tickPlanning called but run.specId is not set',
        },
      },
      deps.now(),
    );
  }
  const spec = deps.store.getSpec(run.specId);
  if (!spec) {
    return applyEvent(
      deps.store,
      run.id,
      {
        type: 'planning_failed',
        failure: {
          category: 'internal',
          message: `spec not found for id ${run.specId}`,
        },
      },
      deps.now(),
    );
  }

  const plannerDeps: PlannerDeps = {
    client: deps.anthropicClient,
    store: deps.store,
    runId: run.id,
    now: deps.now,
    logger: deps.logger,
  };
  const plannerInput: PlannerInput = { spec, targetRepoPath: deps.repoDir };

  const startTime = Date.now();
  const result = await runPlanner(plannerDeps, plannerInput);
  const durationMs = Date.now() - startTime;

  // Persist the planner result regardless of outcome — same rationale as
  // the triage artifact write.
  const runArtifactDir = join(deps.artifactsDir, run.id);
  writePlannerArtifact(runArtifactDir, result, durationMs);

  if (result.ok) {
    const plan = {
      runId: run.id,
      specId: spec.id,
      filesToTouch: result.plan.filesToTouch,
      approach: result.plan.approach,
      risks: result.plan.risks,
      testStrategy: result.plan.testStrategy,
      createdAt: deps.now(),
    };
    deps.store.insertPlan(plan);
    writePlanArtifact(runArtifactDir, plan);

    // Cross-phase budget check: planner usage was just recorded; the sum
    // now includes triage + planner. If we've already blown the budget,
    // fail at this phase instead of letting executor add more.
    const afterPlanner = deps.store.getRun(run.id)!;
    if (checkTokenBudget(deps, afterPlanner, spec)) {
      return applyEvent(
        deps.store,
        run.id,
        {
          type: 'planning_failed',
          failure: {
            category: 'budget_exceeded',
            message: `token budget exceeded after planning: ${afterPlanner.tokensSpent} > ${spec.budget.maxTokens}`,
          },
        },
        deps.now(),
      );
    }

    return applyEvent(
      deps.store,
      run.id,
      { type: 'planning_succeeded' },
      deps.now(),
    );
  }

  // Rejection.
  return applyEvent(
    deps.store,
    run.id,
    {
      type: 'planning_failed',
      failure: {
        category: mapPlannerRejectionToCategory(result.reason),
        message: result.message,
      },
    },
    deps.now(),
  );
}

function mapPlannerRejectionToCategory(
  reason: PlannerRejectionReason,
): FailureCategory {
  switch (reason) {
    case 'unimplementable':
    case 'invalid_output':
      return 'spec_invalid';
    case 'sdk_error':
      return 'transient';
  }
}

const BUDGET_WARN_FRACTION = 0.8;

/**
 * Compare Run.tokensSpent against spec.budget.maxTokens. Emits a
 * warn-level log at >= BUDGET_WARN_FRACTION usage as an early-warning
 * signal even when not yet exceeded — hard cutoffs alone aren't enough,
 * and an early warning is cheap.
 *
 * Returns true if the Run is OVER budget; the caller is expected to apply
 * an `execution_failed` event with category `budget_exceeded`. See the
 * BUDGET ENFORCEMENT NOTE in tickExecuting for the post-call limitation.
 */
function checkTokenBudget(deps: Deps, run: Run, spec: Spec): boolean {
  const used = run.tokensSpent;
  const max = spec.budget.maxTokens;
  if (used > max) return true;
  if (used >= max * BUDGET_WARN_FRACTION) {
    deps.logger.warn('budget: approaching token limit', {
      runId: run.id,
      tokensSpent: used,
      maxTokens: max,
      pctUsed: ((used / max) * 100).toFixed(1),
    });
  }
  return false;
}

/**
 * Stage everything in the worktree and create one commit. We use `git -c`
 * to set author/committer identity inline so the call doesn't depend on
 * whatever the user's global git config happens to be — agent-loop
 * runs should be attributable to "agent-loop", not the host user.
 *
 * Returns ok=false if there is nothing staged after `git add -A`. Pushing
 * an empty branch produces a confusing "No commits between main and X"
 * error from `gh pr create`; catching it here gives the orchestrator a
 * clear failure category and message.
 */
async function commitAgentChanges(
  deps: Deps,
  run: Run,
  spec: Spec,
  worktreePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const add = await runCommand(
    'git',
    ['add', '-A'],
    { cwd: worktreePath, logger: deps.logger },
  );
  if (add.exitCode !== 0 || add.spawnFailed) {
    return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
  }

  // `git diff --cached --quiet` exits 0 when there are no staged changes,
  // 1 when there are. Anything else is an error.
  const diff = await runCommand(
    'git',
    ['diff', '--cached', '--quiet'],
    { cwd: worktreePath, logger: deps.logger },
  );
  if (diff.exitCode === 0) {
    return {
      ok: false,
      error: 'agent produced no file changes (nothing to commit)',
    };
  }

  const message = `${spec.title}\n\nGenerated by agent-loop run ${run.id}`;
  const commit = await runCommand(
    'git',
    [
      '-c',
      'user.name=agent-loop',
      '-c',
      'user.email=agent@agent-loop.local',
      'commit',
      '-m',
      message,
      '--no-verify',
    ],
    { cwd: worktreePath, logger: deps.logger },
  );
  if (commit.exitCode !== 0 || commit.spawnFailed) {
    return { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
  }
  deps.logger.info('committed agent changes', { runId: run.id });
  return { ok: true };
}

function failExecution(
  deps: Deps,
  run: Run,
  failure: Omit<Failure, 'phase'>,
): Promise<Run> {
  return Promise.resolve(
    applyEvent(
      deps.store,
      run.id,
      { type: 'execution_failed', failure },
      deps.now(),
    ),
  );
}

function failPr(deps: Deps, run: Run, message: string): Promise<Run> {
  return Promise.resolve(
    applyEvent(
      deps.store,
      run.id,
      {
        type: 'pr_failed',
        failure: { category: 'internal', message },
      },
      deps.now(),
    ),
  );
}
