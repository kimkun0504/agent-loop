/**
 * `agent-loop eval [--task <name>] [--output-dir <path>] [--verbose]`
 *
 * Runs the eval suite under `<cwd>/evals/tasks/`. Results land in
 * `<cwd>/evals/results/<timestamp>/` (override with --output-dir).
 *
 * Exit code:
 *   0 — pass rate >= QUALITY Tier 1 target (80%)
 *   1 — pass rate below target, or one or more tasks errored fatally
 *   2 — discovery failed (no tasks found)
 *
 * Phase A: this command drives runs via the existing Week-2 path
 * (driveToExecuting + ClaudeCliExecutor + runExitCodeVerifier +
 * NoopPrOpener). Triage and planner do not exist yet; the Spec is
 * hand-rolled from task.md and expected.json. The numbers this
 * produces are the BASELINE that later phases regression-check against.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { openDb } from '@agent-loop/runtime';
import { discoverTasks } from '../eval/discover.js';
import { runOneTask } from '../eval/drive.js';
import { writeResults } from '../eval/report.js';
import type { EvalTaskResult } from '../eval/types.js';

const PASS_RATE_TARGET = 0.8; // QUALITY Tier 1
const EVAL_DB_FILE = 'runs.db';

export interface EvalOptions {
  task?: string;          // run only one task by name
  outputDir?: string;     // override the default results location
  verbose?: boolean;
}

export async function evalCmd(opts: EvalOptions): Promise<number> {
  const cwd = process.cwd();
  const evalsRoot = join(cwd, 'evals');
  if (!existsSync(evalsRoot)) {
    process.stderr.write(
      `eval: no evals/ directory under ${cwd}. Run from the repo root.\n`,
    );
    return 2;
  }

  const { tasks, skipped } = discoverTasks(evalsRoot);
  for (const s of skipped) {
    process.stderr.write(`eval: skipping ${s.name}: ${s.reason}\n`);
  }
  if (tasks.length === 0) {
    process.stderr.write('eval: no valid tasks discovered\n');
    return 2;
  }

  const selected = opts.task
    ? tasks.filter((t) => t.name === opts.task)
    : tasks;
  if (selected.length === 0) {
    process.stderr.write(`eval: no task named "${opts.task}"\n`);
    return 2;
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const resultsDir = opts.outputDir ?? join(evalsRoot, 'results', timestamp);
  mkdirSync(resultsDir, { recursive: true });

  // Fresh eval DB per run keeps post-mortems and per-suite metrics
  // self-contained. The file is gitignored (*.db) and lives next to results.
  const dbPath = join(resultsDir, EVAL_DB_FILE);
  const store = openDb(dbPath);

  process.stdout.write(
    `eval: ${selected.length} task(s), results -> ${resultsDir}\n`,
  );

  const results: EvalTaskResult[] = [];
  for (const task of selected) {
    process.stdout.write(`\neval: running ${task.name}\n`);
    const start = Date.now();
    try {
      const taskArtifactsDir = join(resultsDir, task.name);
      const result = await runOneTask({
        task,
        store,
        workspaceDir: resultsDir,
        artifactsDir: taskArtifactsDir,
        verbose: opts.verbose === true,
      });
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      const outcome = result.passed ? 'PASS' : 'FAIL';
      process.stdout.write(
        `eval: ${task.name} ${outcome} (${dur}s, $${result.costUsd.toFixed(4)}, ${result.tokensSpent} tokens)\n`,
      );
      if (!result.passed && result.failure) {
        process.stdout.write(
          `  failure: [${result.failure.category}] ${result.failure.message}\n`,
        );
      }
      results.push(result);
    } catch (err) {
      // Don't let one task explode the suite.
      process.stderr.write(`eval: ${task.name} ERRORED: ${String(err)}\n`);
      results.push({
        name: task.name,
        passed: false,
        phase: 'failed',
        runId: 'errored',
        durationMs: Date.now() - start,
        tokensSpent: 0,
        costUsd: 0,
        cacheHitRate: 0,
        perPhase: {},
        failure: {
          category: 'internal',
          message: String(err),
          phase: 'queued',
        },
      });
    }
  }

  const summary = await writeResults(resultsDir, results);

  process.stdout.write('\n');
  process.stdout.write(
    `eval: ${summary.passed}/${summary.totalTasks} passed (${(summary.passRate * 100).toFixed(1)}%)\n`,
  );
  process.stdout.write(
    `eval: median cost $${summary.aggregates.medianCostUsd.toFixed(4)}, ` +
      `p95 cost $${summary.aggregates.p95CostUsd.toFixed(4)}, ` +
      `p50 cache hit ${(summary.aggregates.p50CacheHitRate * 100).toFixed(0)}%\n`,
  );
  process.stdout.write(`eval: results -> ${resultsDir}\n`);

  // Cleanup: the eval DB has served its purpose (artifacts on disk + summary
  // are the durable records). Comment out if you want to inspect via
  // agent-loop inspect --db <path> later.
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  } catch {
    // ignore
  }

  return summary.passRate >= PASS_RATE_TARGET ? 0 : 1;
}
