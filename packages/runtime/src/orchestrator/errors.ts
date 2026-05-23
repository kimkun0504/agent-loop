import type { RunId } from '@agent-loop/core';

export class RunNotFoundError extends Error {
  constructor(public readonly runId: RunId) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export class VersionConflictError extends Error {
  constructor(
    public readonly runId: RunId,
    public readonly expectedVersion: number,
  ) {
    super(
      `Version conflict applying event to ${runId} ` +
        `(expected version ${expectedVersion}); another writer modified the row first`,
    );
    this.name = 'VersionConflictError';
  }
}
