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
  isTerminal,
} from '@agent-loop/core';
import type { Store } from '../db/store.js';
import type { Executor } from '../executor/types.js';
import type { PrOpener } from '../pr/types.js';
import type { VerifyOptions } from '../verifier/exitCode.js';
import { addWorktree } from '../git/worktree.js';
import { isStopRequested } from '../fs/stop.js';
import { applyEvent } from './apply.js';

export type Verifier = (
  run: Run,
  spec: Spec,
  options: VerifyOptions,
) => Promise<Verdict>;

export interface Deps {
  store: Store;
  logger: Logger;
  /** Where worktrees live: `<workspaceDir>/<run_id>/worktree`. */
  workspaceDir: string;
  /** Where artifact directories live: `<artifactsDir>/<run_id>/`. */
  artifactsDir: string;
  /** Target repo (the codebase the agent is editing). */
  repoDir: string;
  now: () => string;
  executor: Executor;
  verifier: Verifier;
  prOpener: PrOpener;
}

export async function tick(deps: Deps, run: Run): Promise<Run> {
  if (isStopRequested(deps.workspaceDir)) {
    deps.logger.info('tick: STOP requested; halting', { runId: run.id });
    return run;
  }
  if (isTerminal(run.phase)) return run;

  switch (run.phase) {
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
  mkdirSync(join(deps.artifactsDir, run.id), { recursive: true });

  const result = await deps.executor.execute({
    run,
    spec,
    worktreePath,
    logger: deps.logger,
  });

  if (result.ok) {
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
    return applyEvent(
      deps.store,
      run.id,
      { type: 'pr_opened' },
      deps.now(),
    );
  }
  return failPr(deps, run, result.error);
}

// --- Helpers ---------------------------------------------------------------

function worktreePathFor(deps: Deps, runId: Run['id']): string {
  return join(deps.workspaceDir, runId, 'worktree');
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
