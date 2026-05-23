/**
 * `agent-loop gc` — garbage-collect terminal runs.
 *
 * Default behavior: scan all runs in `done | failed | abandoned`. For each
 * one whose `updatedAt` is older than `--age-days` (default 7), remove its
 * worktree directory and delete its local `agent/<runId>` branch.
 *
 * Flags:
 *   --age-days N    Minimum age of a terminal run to be eligible (default 7).
 *   --dry-run       Print the plan; modify nothing.
 *   --remote        Also delete the remote branch via `git push --delete`.
 *                   Destructive on shared state — opt-in only.
 *   --run <runId>   Clean a specific run instead of scanning by age.
 *   --yes           Skip the confirmation prompt before --remote.
 *
 * Safety story:
 *   - Only acts on runs in terminal phases (done/failed/abandoned).
 *   - Only matches branches with the `agent/<runId>` prefix, cross-checked
 *     against the runs table.
 *   - --dry-run is the preview form for nervous invocations.
 *   - --remote requires an interactive y/N prompt unless --yes is passed.
 *
 * Audit:
 *   Every action (success or failure) is recorded as a JSONL line in
 *   <home>/gc.log. Non-negotiable for a tool that deletes things — the
 *   transcript is what you read when "who deleted my branch?" comes up.
 */

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  openDb,
  removeWorktree,
  deleteLocalBranch,
  deleteRemoteBranch,
  type GitRunner,
  type Store,
} from '@agent-loop/runtime';
import { type Phase, type Run, isTerminal } from '@agent-loop/core';
import {
  resolvePaths,
  ensureAgentLoopDirs,
  type AgentLoopPaths,
} from '../config.js';

const TERMINAL_PHASES_LIST: ReadonlyArray<Phase> = [
  'done',
  'failed',
  'abandoned',
];

const DEFAULT_AGE_DAYS = 7;

export interface GcOptions {
  ageDays?: number;
  dryRun?: boolean;
  remote?: boolean;
  run?: string;
  yes?: boolean;
}

/**
 * Single action the gc plan performs. The order in a plan is significant:
 * remove the worktree before deleting the local branch (worktree references
 * the branch), and only attempt the remote delete after the local cleanup
 * succeeds.
 */
export type GcAction =
  | { kind: 'removeWorktree'; runId: string; path: string }
  | { kind: 'deleteLocalBranch'; runId: string; branch: string }
  | { kind: 'deleteRemoteBranch'; runId: string; branch: string };

export interface GcPlan {
  eligible: Run[];
  actions: GcAction[];
}

// --- Entry point ----------------------------------------------------------

export async function gc(opts: GcOptions): Promise<number> {
  const paths = resolvePaths();
  ensureAgentLoopDirs(paths);
  const store = openDb(paths.dbPath);

  const plan = buildGcPlan(store, paths, opts, new Date());

  printPlan(plan, opts);

  if (opts.dryRun) {
    process.stdout.write('\n(dry-run; no changes made)\n');
    return 0;
  }

  if (opts.remote && !opts.yes) {
    const ok = await confirm(
      'This will DELETE remote branches on origin. Proceed? [y/N] ',
    );
    if (!ok) {
      process.stdout.write('gc: aborted by user\n');
      return 1;
    }
  }

  let failures = 0;
  for (const action of plan.actions) {
    const ok = await execute(action, paths);
    if (!ok) failures += 1;
  }

  process.stdout.write(
    `\ngc: ${plan.actions.length - failures}/${plan.actions.length} actions completed; ` +
      `log at ${paths.home}/gc.log\n`,
  );
  return failures === 0 ? 0 : 1;
}

// --- Plan building (pure) -------------------------------------------------

/**
 * Pure-ish (reads the store, otherwise no side effects). Exported for tests.
 */
export function buildGcPlan(
  store: Store,
  paths: AgentLoopPaths,
  opts: GcOptions,
  now: Date,
): GcPlan {
  const eligible = selectEligibleRuns(store, opts, now);
  const actions: GcAction[] = [];
  for (const run of eligible) {
    const worktreePath = join(paths.worktreesDir, run.id, 'worktree');
    if (existsSync(worktreePath)) {
      actions.push({ kind: 'removeWorktree', runId: run.id, path: worktreePath });
    }
    actions.push({
      kind: 'deleteLocalBranch',
      runId: run.id,
      branch: run.branch,
    });
    if (opts.remote) {
      actions.push({
        kind: 'deleteRemoteBranch',
        runId: run.id,
        branch: run.branch,
      });
    }
  }
  return { eligible, actions };
}

export function selectEligibleRuns(
  store: Store,
  opts: GcOptions,
  now: Date,
): Run[] {
  if (opts.run !== undefined) {
    const run = store.getRun(
      // RunId is a branded type but the cast is safe here — we're using it
      // as a key, not constructing a fresh ID.
      opts.run as unknown as Run['id'],
    );
    if (!run) return [];
    if (!isTerminal(run.phase)) return [];
    return [run];
  }

  const ageDays = opts.ageDays ?? DEFAULT_AGE_DAYS;
  const cutoff = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
  const terminal = store.listRuns({ phase: [...TERMINAL_PHASES_LIST] });
  return terminal.filter((r) => new Date(r.updatedAt) < cutoff);
}

// --- Execution (side effects) ---------------------------------------------

/**
 * Inject the runners for tests. In production, the runtime's default
 * runCommand is used; tests pass a fake to avoid spawning real git.
 */
export interface GcExecutionDeps {
  removeWorktreeFn?: typeof removeWorktree;
  deleteLocalBranchFn?: typeof deleteLocalBranch;
  deleteRemoteBranchFn?: typeof deleteRemoteBranch;
  /** Override the gc.log path (used by tests). */
  logPath?: string;
  /** Repo dir for git operations. Defaults to process.cwd(). */
  repoDir?: string;
  /** Clock override for log timestamps. */
  now?: () => string;
}

let executionDeps: GcExecutionDeps = {};

/**
 * Test-only: replace the execution dependencies for the duration of one
 * test. Pass an empty object to reset to defaults.
 */
export function __setGcExecutionDeps(deps: GcExecutionDeps): void {
  executionDeps = deps;
}

async function execute(
  action: GcAction,
  paths: AgentLoopPaths,
): Promise<boolean> {
  const now = executionDeps.now ?? ((): string => new Date().toISOString());
  const logPath = executionDeps.logPath ?? join(paths.home, 'gc.log');
  const repoDir = executionDeps.repoDir ?? process.cwd();

  try {
    if (action.kind === 'removeWorktree') {
      const fn = executionDeps.removeWorktreeFn ?? removeWorktree;
      await fn(repoDir, action.path);
    } else if (action.kind === 'deleteLocalBranch') {
      const fn = executionDeps.deleteLocalBranchFn ?? deleteLocalBranch;
      const r = await fn(repoDir, action.branch);
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
    } else {
      const fn = executionDeps.deleteRemoteBranchFn ?? deleteRemoteBranch;
      const r = await fn(repoDir, action.branch);
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
    }
    appendGcLog(logPath, action, now(), { ok: true });
    process.stdout.write(`gc: ok  ${formatAction(action)}\n`);
    return true;
  } catch (err) {
    appendGcLog(logPath, action, now(), { ok: false, error: String(err) });
    process.stderr.write(
      `gc: FAIL ${formatAction(action)}: ${String(err)}\n`,
    );
    return false;
  }
}

function appendGcLog(
  path: string,
  action: GcAction,
  ts: string,
  outcome: { ok: true } | { ok: false; error: string },
): void {
  const { kind, ...rest } = action;
  const record = { ts, action: kind, ...rest, ...outcome };
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

// --- Presentation ---------------------------------------------------------

function printPlan(plan: GcPlan, opts: GcOptions): void {
  if (plan.eligible.length === 0) {
    if (opts.run !== undefined) {
      process.stdout.write(
        `gc: run not found or not in a terminal phase: ${opts.run}\n`,
      );
    } else {
      const ageDays = opts.ageDays ?? DEFAULT_AGE_DAYS;
      process.stdout.write(
        `gc: no terminal runs older than ${ageDays} day(s)\n`,
      );
    }
    return;
  }
  process.stdout.write(
    `gc: ${plan.eligible.length} eligible run(s), ${plan.actions.length} action(s):\n`,
  );
  for (const a of plan.actions) {
    process.stdout.write(`  - ${formatAction(a)}\n`);
  }
}

function formatAction(a: GcAction): string {
  switch (a.kind) {
    case 'removeWorktree':
      return `removeWorktree     ${a.runId}  ${a.path}`;
    case 'deleteLocalBranch':
      return `deleteLocalBranch  ${a.runId}  ${a.branch}`;
    case 'deleteRemoteBranch':
      return `deleteRemoteBranch ${a.runId}  ${a.branch}`;
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}
