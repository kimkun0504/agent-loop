/**
 * git worktree helpers.
 *
 * Each run gets its own worktree at `<workspaceDir>/<run_id>/worktree`, on
 * a fresh branch keyed by the run id. Worktrees are isolated checkouts of
 * the target repo — the agent works there, never against the main checkout.
 *
 * `addWorktree` fails loudly if the target path exists. The orchestrator
 * decides cleanup policy explicitly (week 2: fresh path per run, never
 * recreated; week 3 retry path will call `removeWorktree` before retrying).
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { runCommand, type RunCommandResult } from '../proc/run.js';
import { WorktreeAlreadyExistsError } from './errors.js';

export type GitRunner = (
  command: string,
  args: string[],
  options?: Parameters<typeof runCommand>[2],
) => Promise<RunCommandResult>;

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
}

/**
 * Create a new worktree at `path`, checking out a new branch `branch`
 * starting from HEAD of the repo at `repo`. Throws if `path` already
 * exists on disk.
 */
export async function addWorktree(
  repo: string,
  branch: string,
  path: string,
): Promise<void> {
  if (existsSync(path)) {
    throw new WorktreeAlreadyExistsError(path);
  }
  await execa('git', ['worktree', 'add', '-b', branch, path], { cwd: repo });
}

/**
 * Remove a worktree. Uses --force so that uncommitted changes in the
 * worktree don't block teardown — the orchestrator owns the worktree's
 * lifecycle and never has reason to preserve in-flight edits.
 */
export async function removeWorktree(
  repo: string,
  path: string,
): Promise<void> {
  await execa('git', ['worktree', 'remove', '--force', path], { cwd: repo });
}

/**
 * List worktrees as reported by `git worktree list --porcelain`. The main
 * checkout is included as the first entry. Detached worktrees have a null
 * branch.
 */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const { stdout } = await execa(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: repo },
  );
  return parseWorktreePorcelain(stdout);
}

/**
 * Delete a local branch in the given repo. `git branch -D` is used (force)
 * so an unmerged agent branch is removed without prompting — agent-loop
 * tracks merge state via the Run.phase, not git's merge bookkeeping.
 *
 * Returns the raw RunCommandResult so the caller can record success/failure
 * to its audit log without unwrapping exceptions.
 */
export async function deleteLocalBranch(
  repoDir: string,
  branch: string,
  opts: { runner?: GitRunner } = {},
): Promise<RunCommandResult> {
  const runner = opts.runner ?? runCommand;
  return runner('git', ['-C', repoDir, 'branch', '-D', branch]);
}

/**
 * Delete a remote branch via `git push origin --delete <branch>`. DESTRUCTIVE
 * on shared state — callers (the gc command) must require explicit opt-in
 * before invoking this, and never default to it.
 */
export async function deleteRemoteBranch(
  repoDir: string,
  branch: string,
  opts: { runner?: GitRunner } = {},
): Promise<RunCommandResult> {
  const runner = opts.runner ?? runCommand;
  return runner('git', ['-C', repoDir, 'push', 'origin', '--delete', branch]);
}

// Exported for tests. Each worktree block is separated by a blank line and
// contains `worktree <path>`, `HEAD <sha>`, and either `branch <ref>` or
// `detached`. Unknown lines are ignored.
export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  const flush = (): void => {
    if (current.path !== undefined && current.head !== undefined) {
      entries.push({
        path: current.path,
        head: current.head,
        branch: current.branch ?? null,
      });
    }
    current = {};
  };

  for (const line of text.split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'detached') {
      current.branch = null;
    }
  }
  flush();
  return entries;
}
