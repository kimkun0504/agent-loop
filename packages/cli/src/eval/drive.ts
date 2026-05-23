/**
 * Drive one eval task end-to-end and capture metrics.
 *
 * For Phase A (baseline) there is no triage or planner agent yet. The
 * runner hand-rolls a Spec from task.md + expected.json and applies the
 * triage/spec/plan events directly via the existing `driveToExecuting`
 * helper. Once Phase D lands, the runner will go through real triage
 * instead of synthesizing.
 *
 * One task = one run = one row in evals/runs.db.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BUDGET,
  Logger,
  RunId,
  SpecId,
  TaskId,
  createRun,
  isTerminal,
  type Spec,
} from '@agent-loop/core';
import {
  ClaudeCliExecutor,
  runExitCodeVerifier,
  tick,
  isStopRequested,
  type Deps,
  type Store,
} from '@agent-loop/runtime';
import { driveToExecuting } from '../drive.js';
import { NoopPrOpener } from './noopPr.js';
import { setupEvalEnv, tearDownEvalEnv } from './fixture.js';
import { computeRunMetrics, cacheHitRate } from './metrics.js';
import type { EvalTask, EvalTaskResult } from './types.js';

export interface RunOneOptions {
  task: EvalTask;
  store: Store;
  /** Top-level workspace for the run (where the STOP file would live). */
  workspaceDir: string;
  /** Where this task's artifacts land (persists past the tmpdir). */
  artifactsDir: string;
  /** Whether to print interim log output (--verbose). Default false. */
  verbose?: boolean;
}

export async function runOneTask(opts: RunOneOptions): Promise<EvalTaskResult> {
  const env = await setupEvalEnv({
    taskName: opts.task.name,
    basePath: opts.task.basePath,
    artifactsDir: opts.artifactsDir,
  });

  const runIdStr = `eval-${opts.task.name}-${randomUUID().slice(0, 8)}`;
  const runId = RunId(runIdStr);
  const now = (): string => new Date().toISOString();

  try {
    const logger = new Logger({
      level: opts.verbose ? 'info' : 'warn',
      console: Boolean(opts.verbose),
    });

    const run = createRun({
      id: runId,
      taskId: TaskId(`eval:${opts.task.name}`),
      artifactDir: env.artifactsDir,
      branch: `agent/${runIdStr}`,
      now: now(),
    });
    opts.store.insertRun(run);

    const spec = buildEvalSpec(opts.task, runId, now());
    driveToExecuting({ store: opts.store, spec, now, logger });

    const deps: Deps = {
      store: opts.store,
      logger,
      workspaceDir: opts.workspaceDir,
      worktreesDir: env.worktreesDir,
      artifactsDir: env.artifactsDir, // already the per-task artifactsDir; tick joins runId again
      repoDir: env.repoDir,
      now,
      executor: new ClaudeCliExecutor(),
      verifier: runExitCodeVerifier,
      prOpener: new NoopPrOpener(),
    };

    // Drive ticks until terminal.
    while (true) {
      if (isStopRequested(opts.workspaceDir)) {
        logger.warn('eval: STOP file present; bailing on task', { runId });
        break;
      }
      const current = opts.store.getRun(runId);
      if (!current || isTerminal(current.phase)) break;
      try {
        await tick(deps, current);
      } catch (err) {
        logger.error('eval: tick threw', { runId, err: String(err) });
        break;
      }
    }

    return summarize(opts.store, opts.task.name, runId);
  } finally {
    tearDownEvalEnv(env);
  }
}

function buildEvalSpec(task: EvalTask, runId: RunId, now: string): Spec {
  return {
    id: SpecId(`spec-${runId}`),
    runId,
    title: `eval: ${task.name}`,
    description: task.taskMd.trim(),
    // Generic file scope — eval target repos all live under src/ + test/.
    fileScope: ['src/**/*', 'test/**/*'],
    acceptanceCriteria: task.expected.acceptanceCriteria,
    testCommands: task.expected.testCommands,
    budget: DEFAULT_BUDGET,
    createdAt: now,
  };
}

function summarize(store: Store, name: string, runId: RunId): EvalTaskResult {
  const finalRun = store.getRun(runId);
  if (!finalRun) {
    throw new Error(`eval: run vanished from store: ${runId}`);
  }
  const events = store.listEvents(runId);
  const metrics = computeRunMetrics(events);
  const verdicts = store.listVerdicts(runId);
  const lastVerdict = verdicts[verdicts.length - 1];
  const passed =
    finalRun.phase === 'done' && lastVerdict?.pass === true;

  return {
    name,
    passed,
    phase: finalRun.phase,
    runId,
    durationMs: metrics.durationMs,
    tokensSpent: metrics.totals.tokensSpent,
    costUsd: metrics.totals.costUsd,
    cacheHitRate: cacheHitRate(
      metrics.totals.cacheReadTokens,
      metrics.totals.totalInputTokens,
    ),
    perPhase: metrics.perPhase,
    failure: finalRun.failure ?? null,
  };
}
