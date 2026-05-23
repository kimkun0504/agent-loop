/**
 * PrOpener port. Like Executor and Verifier, the orchestrator depends on
 * this interface, not on `gh` directly. Week 2 ships GhPrOpener; future
 * targets (GitLab, Bitbucket, internal review tools) plug in here.
 */

import type { Logger, Run, Spec, Verdict } from '@agent-loop/core';

export interface PrOpenInput {
  run: Run;
  spec: Spec;
  /** The passing verdict that motivated opening the PR. */
  verdict: Verdict;
  /** Worktree the branch lives in; PR is opened against this checkout. */
  worktreePath: string;
  logger?: Logger;
  signal?: AbortSignal;
}

export type PrOpenResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export interface PrOpener {
  openPullRequest(input: PrOpenInput): Promise<PrOpenResult>;
}
