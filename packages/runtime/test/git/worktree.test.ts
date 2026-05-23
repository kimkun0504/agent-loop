/**
 * git/worktree tests use a real git repo in a tmpdir. Fast enough (<1s).
 * We pin user.name/user.email via -c so the tests don't depend on the
 * machine's global git config.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWorktree,
  removeWorktree,
  listWorktrees,
  parseWorktreePorcelain,
} from '../../src/git/worktree.js';
import { WorktreeAlreadyExistsError } from '../../src/git/errors.js';

const GIT_ID = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.com',
];

let repo: string;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agent-loop-worktree-'));
  repo = join(tmpRoot, 'repo');
  await execa('git', ['init', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  await execa('git', [...GIT_ID, 'add', '.'], { cwd: repo });
  await execa('git', [...GIT_ID, 'commit', '-m', 'init'], { cwd: repo });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Each test gets its own worktree path so they don't collide.
let wtCounter = 0;
function freshWorktreePath(): string {
  wtCounter += 1;
  return join(tmpRoot, `wt-${wtCounter}`);
}

beforeEach(() => {
  wtCounter += 0; // no-op; counter just keeps incrementing across tests
});

describe('addWorktree', () => {
  it('creates a worktree at the given path with a new branch', async () => {
    const wt = freshWorktreePath();
    await addWorktree(repo, 'agent/run-a', wt);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, 'README.md'))).toBe(true);

    const { stdout } = await execa('git', ['branch', '--show-current'], { cwd: wt });
    expect(stdout.trim()).toBe('agent/run-a');
  });

  it('throws WorktreeAlreadyExistsError if the path already exists', async () => {
    const wt = freshWorktreePath();
    await addWorktree(repo, 'agent/run-b', wt);
    await expect(addWorktree(repo, 'agent/run-b2', wt)).rejects.toBeInstanceOf(
      WorktreeAlreadyExistsError,
    );
  });

  it('does not silently reuse a directory not registered as a worktree', async () => {
    const wt = freshWorktreePath();
    // Pre-create a plain directory.
    await execa('mkdir', ['-p', wt]);
    await expect(addWorktree(repo, 'agent/run-c', wt)).rejects.toBeInstanceOf(
      WorktreeAlreadyExistsError,
    );
  });

  it('propagates git errors when the branch already exists', async () => {
    const wt1 = freshWorktreePath();
    const wt2 = freshWorktreePath();
    await addWorktree(repo, 'agent/dup', wt1);
    // -b on an existing branch fails. We don't translate the error; the
    // caller (orchestrator) gets the raw execa rejection.
    await expect(addWorktree(repo, 'agent/dup', wt2)).rejects.toThrow();
  });
});

describe('removeWorktree', () => {
  it('removes a previously-added worktree directory', async () => {
    const wt = freshWorktreePath();
    await addWorktree(repo, 'agent/to-remove', wt);
    expect(existsSync(wt)).toBe(true);
    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
  });

  it('removes a worktree with uncommitted changes (uses --force)', async () => {
    const wt = freshWorktreePath();
    await addWorktree(repo, 'agent/dirty', wt);
    writeFileSync(join(wt, 'scratch.txt'), 'untracked\n');
    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
  });
});

describe('listWorktrees', () => {
  it('includes the main checkout plus any added worktrees', async () => {
    // On macOS the tmpdir lives under /var/folders/... which git resolves to
    // /private/var/folders/...; compare canonical paths.
    const wt = freshWorktreePath();
    await addWorktree(repo, 'agent/list-check', wt);
    const entries = await listWorktrees(repo);
    const paths = entries.map((e) => realpathSync(e.path));
    expect(paths).toContain(realpathSync(repo));
    expect(paths).toContain(realpathSync(wt));
    const added = entries.find((e) => realpathSync(e.path) === realpathSync(wt));
    expect(added?.branch).toBe('refs/heads/agent/list-check');
  });
});

describe('parseWorktreePorcelain', () => {
  it('parses the documented porcelain format', () => {
    const text = [
      'worktree /repos/foo',
      'HEAD abcdef1234567890',
      'branch refs/heads/main',
      '',
      'worktree /repos/foo-wt',
      'HEAD 1111111111111111',
      'branch refs/heads/feature',
      '',
    ].join('\n');
    const entries = parseWorktreePorcelain(text);
    expect(entries).toEqual([
      { path: '/repos/foo', head: 'abcdef1234567890', branch: 'refs/heads/main' },
      {
        path: '/repos/foo-wt',
        head: '1111111111111111',
        branch: 'refs/heads/feature',
      },
    ]);
  });

  it('marks detached worktrees with branch: null', () => {
    const text = [
      'worktree /repos/foo',
      'HEAD abcdef1234567890',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreePorcelain(text)).toEqual([
      { path: '/repos/foo', head: 'abcdef1234567890', branch: null },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });

  it('handles input without a trailing blank line', () => {
    const text = [
      'worktree /repos/foo',
      'HEAD abcdef1234567890',
      'branch refs/heads/main',
    ].join('\n');
    expect(parseWorktreePorcelain(text)).toEqual([
      { path: '/repos/foo', head: 'abcdef1234567890', branch: 'refs/heads/main' },
    ]);
  });
});
