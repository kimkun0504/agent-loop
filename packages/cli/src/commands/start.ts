/**
 * `agent-loop start --spec <name> --target <path>`
 *
 * End-to-end command. Blocks until the run reaches a terminal phase.
 *
 * Lifecycle:
 *   1. Validate the spec name (must be in SPECS registry).
 *   2. Validate the target path: it must exist, be a git repo, and be
 *      clean (`git status --porcelain` returns empty). Worktrees branch
 *      from clean state only — dirty repos refuse loudly.
 *   3. Open the DB, create the Run, drive it through triage/spec/plan
 *      manual phases into `executing`.
 *   4. Wire up real ClaudeCliExecutor + runExitCodeVerifier + GhPrOpener.
 *   5. Register a SIGINT handler that applies an `abandon` event before
 *      exiting — never leave a run stuck mid-phase.
 *   6. Run the loop until the run is terminal.
 *   7. Print final state + PR URL (if done) and exit with a code that
 *      reflects the outcome.
 *
 * Exit codes:
 *   0   — phase=done; PR opened
 *   1   — phase=failed, or any pre-flight validation refused
 *   130 — phase=abandoned (SIGINT, conventionally 128+SIGINT=2)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Logger,
  RunId,
  TaskId,
  createRun,
  isTerminal,
} from '@agent-loop/core';
import {
  openDb,
  applyEvent,
  runCommand,
  runExitCodeVerifier,
  ClaudeCliExecutor,
  GhPrOpener,
  tick,
  isStopRequested,
  type Deps,
} from '@agent-loop/runtime';
import { SPECS, SPEC_NAMES } from '@agent-loop/example-specs';
import { resolvePaths, ensureAgentLoopDirs } from '../config.js';
import { driveToExecuting } from '../drive.js';
import { formatRunDetail } from '../format.js';

export interface StartOptions {
  spec: string;
  target: string;
}

export async function start(opts: StartOptions): Promise<number> {
  const paths = resolvePaths();
  ensureAgentLoopDirs(paths);

  const logger = new Logger({
    level: 'info',
    console: true,
    filePath: paths.cliLogPath,
  });

  // --- Pre-flight validation -----------------------------------------------

  const buildSpec = SPECS[opts.spec];
  if (!buildSpec) {
    process.stderr.write(
      `start: unknown spec "${opts.spec}". Known: ${SPEC_NAMES.join(', ')}\n`,
    );
    return 1;
  }

  const target = opts.target;
  const check = await checkTargetClean(target, logger);
  if (!check.ok) {
    process.stderr.write(`start: ${check.error}\n`);
    return 1;
  }

  // --- Create the run and drive to executing -------------------------------

  const store = openDb(paths.dbPath);
  const now = (): string => new Date().toISOString();
  const runIdStr = 'run-' + randomUUID().slice(0, 8);
  const runId = RunId(runIdStr);

  const run = createRun({
    id: runId,
    // taskId is "hardcoded" in week 2; later it'll point at the inbox item.
    taskId: TaskId('hardcoded'),
    artifactDir: join(paths.artifactsDir, runIdStr),
    branch: `agent/${runIdStr}`,
    now: now(),
  });
  store.insertRun(run);
  logger.info('start: created run', { runId, target, spec: opts.spec });

  const spec = buildSpec(runId, now());
  driveToExecuting({ store, spec, now, logger });

  // --- Wire deps -----------------------------------------------------------

  const deps: Deps = {
    store,
    logger,
    workspaceDir: paths.home,
    worktreesDir: paths.worktreesDir,
    artifactsDir: paths.artifactsDir,
    repoDir: target,
    now,
    executor: new ClaudeCliExecutor(),
    verifier: runExitCodeVerifier,
    // GhPrOpener returns the URL on success; tick.ts threads it into the
    // pr_opened event payload, and the transition handler sets Run.prUrl.
    // No closure capture needed — read final.prUrl after the loop.
    prOpener: new GhPrOpener(),
  };

  // --- SIGINT: write abandon event before exiting --------------------------

  const controller = new AbortController();
  let sigintFired = false;
  const handleSigint = (): void => {
    sigintFired = true;
    process.stderr.write('\nstart: SIGINT received; abandoning run\n');
    const current = store.getRun(runId);
    if (current && !isTerminal(current.phase)) {
      try {
        applyEvent(
          store,
          runId,
          { type: 'abandon', reason: 'user interrupted (SIGINT)' },
          now(),
        );
        logger.info('start: applied abandon on SIGINT', { runId });
      } catch (err) {
        logger.error('start: failed to apply abandon on SIGINT', {
          runId,
          err: String(err),
        });
      }
    }
    controller.abort();
  };
  process.once('SIGINT', handleSigint);

  // --- Drive THIS run until terminal --------------------------------------
  //
  // We don't use runLoop here. runLoop is the "keep an orchestrator alive"
  // poller — it never exits on its own when the queue empties. `start` is
  // single-shot: drive one specific run to terminal and return. Iterating
  // tick() directly until the run is terminal is exactly that, plus it
  // skips runLoop's 2s sleeps between phases (each tick advances a phase
  // immediately, so the happy path is ~3 ticks back-to-back).

  try {
    while (true) {
      if (controller.signal.aborted) break;
      if (isStopRequested(paths.home)) {
        logger.info('start: STOP file present; halting', { runId });
        break;
      }
      const current = store.getRun(runId);
      if (!current) {
        logger.error('start: run vanished from store', { runId });
        break;
      }
      if (isTerminal(current.phase)) break;
      try {
        await tick(deps, current);
      } catch (err) {
        logger.error('start: tick threw', { runId, err: String(err) });
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', handleSigint);
  }

  // --- Report outcome ------------------------------------------------------

  const final = store.getRun(runId)!;
  process.stdout.write('\n' + formatRunDetail(final));

  if (final.phase === 'done') {
    if (final.prUrl) {
      process.stdout.write(`PR: ${final.prUrl}\n`);
    } else {
      process.stdout.write('PR: (URL not captured — check `gh pr list`)\n');
    }
    return 0;
  }
  if (final.phase === 'abandoned') {
    process.stdout.write(
      `Abandoned: ${final.abandonedReason ?? 'unknown'}\n`,
    );
    return sigintFired ? 130 : 1;
  }
  if (final.phase === 'failed') {
    process.stdout.write(
      `Failed: [${final.failure?.category}] ${final.failure?.message}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Loop exited with run still in non-terminal phase ${final.phase} ` +
      `(STOP file present?). See \`agent-loop inspect ${runId}\`.\n`,
  );
  return 1;
}

// --- Helpers ---------------------------------------------------------------

async function checkTargetClean(
  target: string,
  logger: Logger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!existsSync(target)) {
    return { ok: false, error: `target path does not exist: ${target}` };
  }
  const r = await runCommand('git', ['-C', target, 'status', '--porcelain'], {
    logger,
  });
  if (r.exitCode !== 0 || r.spawnFailed) {
    return {
      ok: false,
      error: `git status failed in ${target} (not a git repo?): exit ${r.exitCode}${r.stderr ? `; ${r.stderr.trim()}` : ''}`,
    };
  }
  if (r.stdout.trim().length > 0) {
    return {
      ok: false,
      error: `target repo ${target} is dirty:\n${r.stdout.trim()}\n(commit, stash, or clean before starting)`,
    };
  }
  return { ok: true };
}
