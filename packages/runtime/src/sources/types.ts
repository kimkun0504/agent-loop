/**
 * TaskSource — the orchestrator's port for inbound work.
 *
 * The orchestrator depends on this interface, not on any concrete source.
 * Phase F (Week 3) ships GhTaskSource. Later weeks may add Linear, a
 * local-files implementation, etc. without touching the orchestrator.
 *
 * The interface intentionally includes the mark* state-transition methods
 * up front so every implementation reports back to its origin in the same
 * shape — agents on GitHub get labels and comments, a future local-files
 * source might write status to a sibling file, but the orchestrator
 * doesn't have to care which.
 */

import type { Task, TaskId, RunId } from '@agent-loop/core';

export interface TaskSource {
  /** Stable id of the source (e.g., "github:owner/repo"). */
  readonly id: string;

  /** Pull up to `limit` tasks that have not yet been picked up. */
  fetchNew(opts?: { limit?: number }): Promise<Task[]>;

  /**
   * Fetch a specific task by id. Returns null if the task doesn't exist
   * or isn't accessible. Used by the `--issue <n>` CLI path so we don't
   * have to filter through `fetchNew` (which is brittle if the source's
   * label state changed between when the human ran the CLI and when the
   * orchestrator looked).
   */
  fetchById(taskId: TaskId): Promise<Task | null>;

  /** Acknowledge that a task is being worked. */
  markStarted(taskId: TaskId, runId: RunId): Promise<void>;

  /** Mark a task complete with the PR URL. */
  markDone(taskId: TaskId, runId: RunId, prUrl: string): Promise<void>;

  /** Mark a task failed with a reason. */
  markFailed(taskId: TaskId, runId: RunId, reason: string): Promise<void>;

  /** Mark a task as needs-clarification (triage rejection with questions). */
  markNeedsInfo(taskId: TaskId, runId: RunId, questions: string[]): Promise<void>;
}
