/**
 * Run factory. Pure — produces a Run from inputs, doesn't write anywhere.
 */

import type { Run, RunId, TaskId } from '../types/index.js';

export interface NewRunInput {
  id: RunId;
  taskId: TaskId;
  artifactDir: string;
  branch: string;
  now: string;
}

export function createRun(input: NewRunInput): Run {
  return {
    id: input.id,
    taskId: input.taskId,
    artifactDir: input.artifactDir,
    branch: input.branch,
    phase: 'queued',
    version: 0,
    createdAt: input.now,
    updatedAt: input.now,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  };
}
