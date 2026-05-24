/**
 * git diff helper for the verifier.
 *
 * The semantic verifier needs the agent's changes vs the pre-edit baseline.
 * `git diff <base>..HEAD` produces exactly that — the inclusive diff of
 * everything the agent's commits added (a single commit in week 2/3, but
 * the API works for multi-commit branches too).
 *
 * The base ref is the spec's intended baseline (typically `main`); the
 * worktree's branch is the agent's. We use `..HEAD` rather than `..` to
 * be explicit: we want the agent's tree state, not the diff in either
 * direction.
 */

import { runCommand, type RunCommandResult } from '../proc/run.js';

export type DiffRunner = (
  command: string,
  args: string[],
  options?: Parameters<typeof runCommand>[2],
) => Promise<RunCommandResult>;

export interface GetDiffOptions {
  cwd: string;
  baseRef?: string;
  runner?: DiffRunner;
  timeoutMs?: number;
}

export async function getDiffSinceBase(
  options: GetDiffOptions,
): Promise<string> {
  const runner = options.runner ?? runCommand;
  const baseRef = options.baseRef ?? 'main';
  const timeoutMs = options.timeoutMs ?? 30_000;

  const result = await runner('git', ['diff', `${baseRef}..HEAD`], {
    cwd: options.cwd,
    timeoutMs,
  });

  if (result.spawnFailed || result.timedOut || result.exitCode !== 0) {
    return '';
  }
  return result.stdout;
}
