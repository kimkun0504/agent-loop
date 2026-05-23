export class WorktreeAlreadyExistsError extends Error {
  constructor(public readonly path: string) {
    super(`Worktree path already exists: ${path}`);
    this.name = 'WorktreeAlreadyExistsError';
  }
}
