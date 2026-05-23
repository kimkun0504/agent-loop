/**
 * Set up an eval task's working environment.
 *
 * For each task, the runner needs:
 *   - A target repo (a fresh tmpdir with base/ copied in and `git init`
 *     + one initial commit made by a sentinel author).
 *   - A worktrees dir (sibling of the repo) where the agent's worktree
 *     will land.
 *   - An artifacts dir (under the per-run results path) where the runtime
 *     writers persist executor/verdict/meta JSON.
 *
 * setupEvalEnv mkdirs + copies + git inits everything. tearDownEvalEnv
 * removes the tmpdir but leaves the artifacts dir intact (artifacts are
 * the evidence; they outlive the run).
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

const GIT_ID = [
  '-c',
  'user.name=agent-loop-eval',
  '-c',
  'user.email=eval@agent-loop.local',
];

export interface EvalEnv {
  /** Tmpdir root for this task; cleaned up by tearDown. */
  root: string;
  /** Fully-initialized target git repo. */
  repoDir: string;
  /** Where the agent's worktree will live (still under tmpdir). */
  worktreesDir: string;
  /** Persistent artifacts dir (under the results dir, NOT under tmpdir). */
  artifactsDir: string;
}

export interface SetupOptions {
  taskName: string;
  basePath: string;
  /** Persistent results dir for this task (e.g.
   *  evals/results/<ts>/<taskName>/artifacts/). The setup creates it. */
  artifactsDir: string;
}

export async function setupEvalEnv(opts: SetupOptions): Promise<EvalEnv> {
  const root = mkdtempSync(join(tmpdir(), `agent-loop-eval-${opts.taskName}-`));
  const repoDir = join(root, 'repo');
  const worktreesDir = join(root, 'worktrees');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(opts.artifactsDir, { recursive: true });

  // Copy base/ contents into repoDir.
  cpSync(opts.basePath, repoDir, { recursive: true });

  // git init -b main + sentinel-author initial commit.
  await execa('git', ['init', '-b', 'main', repoDir]);
  await execa('git', [...GIT_ID, 'add', '.'], { cwd: repoDir });
  await execa('git', [...GIT_ID, 'commit', '-m', 'eval: initial fixture state'], {
    cwd: repoDir,
  });

  return {
    root,
    repoDir,
    worktreesDir,
    artifactsDir: opts.artifactsDir,
  };
}

export function tearDownEvalEnv(env: EvalEnv): void {
  rmSync(env.root, { recursive: true, force: true });
}
