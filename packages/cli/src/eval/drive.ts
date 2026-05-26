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
  type Task,
} from '@agent-loop/core';
import {
  ClaudeCliExecutor,
  runVerifier,
  tick,
  isStopRequested,
  writeMetaArtifact,
  applyEvent,
  type AnthropicClient,
  type Deps,
  type Store,
} from '@agent-loop/runtime';
import { join } from 'node:path';
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
  /**
   * Phase D: when true, drive the run through real triage instead of
   * hand-rolling a Spec from task.md + expected.json. Requires
   * anthropicClient.
   */
  withTriage?: boolean;
  /** Required when withTriage is true. */
  anthropicClient?: AnthropicClient;
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

    if (opts.withTriage && !opts.anthropicClient) {
      throw new Error('runOneTask: withTriage=true requires an anthropicClient');
    }

    const taskId = TaskId(`eval:${opts.task.name}`);
    const run = createRun({
      id: runId,
      taskId,
      artifactDir: env.artifactsDir,
      branch: `agent/${runIdStr}`,
      now: now(),
    });
    opts.store.insertRun(run);

    if (opts.withTriage) {
      // Triage mode: insert the Task row, apply start_triage, and let the
      // tick loop carry the run through tickTriaging + the bridge auto-
      // advance cases (awaiting_spec_approval, planning, awaiting_plan_approval)
      // into executing. No hand-rolled spec.
      const task: Task = {
        id: taskId,
        title: opts.task.name,
        body: opts.task.taskMd,
        source: 'eval',
        createdAt: now(),
      };
      opts.store.insertTask(task);
      applyEvent(opts.store, runId, { type: 'start_triage' }, now());
    } else {
      // Baseline mode: synthesize a Spec from task.md + expected.json and
      // drive directly to executing — the same path the Phase A baseline
      // ran. No Task row needed.
      const spec = buildEvalSpec(opts.task, runId, now());
      driveToExecuting({ store: opts.store, spec, now, logger });
    }

    const deps: Deps = {
      store: opts.store,
      logger,
      workspaceDir: opts.workspaceDir,
      worktreesDir: env.worktreesDir,
      artifactsDir: env.artifactsDir, // already the per-task artifactsDir; tick joins runId again
      repoDir: env.repoDir,
      now,
      executor: new ClaudeCliExecutor(),
      // Pass the same Anthropic client through to the semantic verifier
      // (Sonnet). The composer handles the no-client case (exit-code only)
      // for callers that haven't loaded credentials.
      verifier: (run, spec, options) =>
        runVerifier(run, spec, {
          ...options,
          ...(opts.anthropicClient !== undefined
            ? { client: opts.anthropicClient }
            : {}),
        }),
      prOpener: new NoopPrOpener(),
      ...(opts.anthropicClient !== undefined ? { anthropicClient: opts.anthropicClient } : {}),
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

    // Mirror what cli/start.ts does at terminal: write meta.json into the
    // per-run artifacts dir so the on-disk artifact set is the same for
    // eval runs as for production runs. The runtime's writers all use
    // <artifactsDir>/<runId>/ as the per-run dir; we match that path.
    const finalRunForMeta = opts.store.getRun(runId);
    if (finalRunForMeta) {
      const finalSpec = opts.store.getSpecByRun(runId);
      const verdicts = opts.store.listVerdicts(runId);
      writeMetaArtifact(
        join(env.artifactsDir, runId),
        finalRunForMeta,
        finalSpec,
        verdicts[verdicts.length - 1],
      );
    }

    return summarize(opts.store, opts.task.name, runId);
  } finally {
    tearDownEvalEnv(env);
  }
}

function buildEvalSpec(task: EvalTask, runId: RunId, now: string): Spec {
  const spec: Spec = {
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
  if (task.expected.fileStateChecks !== undefined) {
    spec.fileStateChecks = task.expected.fileStateChecks;
  }
  return spec;
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
