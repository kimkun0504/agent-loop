/**
 * Executor port. The orchestrator depends on this interface, not on any
 * concrete agent. Week 2 ships ClaudeCliExecutor; later weeks may add a
 * direct-SDK executor or a Docker-isolated executor without touching the
 * orchestrator.
 */

import type { Logger, Run, Spec, TokenUsage } from '@agent-loop/core';

export interface ExecutorInput {
  run: Run;
  spec: Spec;
  /** The worktree the agent should edit in. */
  worktreePath: string;
  logger?: Logger;
  signal?: AbortSignal;
}

export interface ExecutorResult {
  /**
   * True when the agent process completed normally with a zero exit code.
   * False does NOT mean the diff is wrong — only that the agent crashed,
   * timed out, or was killed. The verifier is the authority on correctness.
   */
  ok: boolean;
  exitCode: number;
  durationMs: number;
  /** stdout + stderr concatenated for the artifact log. */
  outputLog: string;
  /** True if the agent's wall-clock budget elapsed. */
  timedOut: boolean;
  /** True if the agent binary couldn't be found / spawned. */
  spawnFailed: boolean;
  /**
   * Token usage reported by the agent, when the executor can extract it.
   * Undefined when the executor doesn't parse usage (test stubs) or when
   * the agent's output couldn't be parsed (logged as a warn at the call site).
   */
  usage?: TokenUsage;
}

export interface Executor {
  execute(input: ExecutorInput): Promise<ExecutorResult>;
}
