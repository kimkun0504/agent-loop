import { describe, expect, it } from 'vitest';
import {
  type Run,
  type Spec,
  type Verdict,
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
} from '@agent-loop/core';
import {
  GhPrOpener,
  defaultBuildTitle,
  defaultBuildBody,
  parsePrUrl,
  type PrRunner,
} from '../../src/pr/open.js';
import type { RunCommandResult } from '../../src/proc/run.js';

const NOW = '2026-01-01T00:00:00.000Z';

function sampleRun(): Run {
  return {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    artifactDir: '/runs/run-1',
    branch: 'agent/run-1',
    phase: 'opening_pr',
    version: 7,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  };
}

function sampleSpec(): Spec {
  return {
    id: SpecId('spec-1'),
    runId: RunId('run-1'),
    title: 'Add a passing test for foo',
    description: 'The foo function needs a passing unit test.',
    fileScope: ['src/foo.ts'],
    acceptanceCriteria: ['Tests pass'],
    testCommands: ['pnpm test'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  };
}

function sampleVerdict(): Verdict {
  return {
    runId: RunId('run-1'),
    pass: true,
    testResults: [
      {
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 250,
        outputSummary: 'ok',
      },
    ],
    semanticCheck: { matches: true, reasoning: 'stub' },
    createdAt: NOW,
  };
}

function fakeOk(stdout = ''): RunCommandResult {
  return {
    command: '',
    args: [],
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  };
}

function fakeFail(stderr: string, exitCode = 1): RunCommandResult {
  return {
    command: '',
    args: [],
    exitCode,
    stdout: '',
    stderr,
    durationMs: 1,
    timedOut: false,
    spawnFailed: false,
  };
}

describe('parsePrUrl', () => {
  it('extracts a standard github.com PR URL', () => {
    expect(parsePrUrl('https://github.com/foo/bar/pull/42\n')).toBe(
      'https://github.com/foo/bar/pull/42',
    );
  });

  it('extracts a URL when there is leading noise', () => {
    const out = [
      'Creating pull request for agent/run-1 into main in foo/bar',
      '',
      'https://github.com/foo/bar/pull/9001',
    ].join('\n');
    expect(parsePrUrl(out)).toBe('https://github.com/foo/bar/pull/9001');
  });

  it('returns null when no URL is present', () => {
    expect(parsePrUrl('No URL here')).toBeNull();
  });

  it('matches GHES-style custom hostnames', () => {
    expect(parsePrUrl('https://ghes.internal/foo/bar/pull/1')).toBe(
      'https://ghes.internal/foo/bar/pull/1',
    );
  });
});

describe('defaultBuildTitle', () => {
  it('returns the spec title', () => {
    expect(
      defaultBuildTitle({
        run: sampleRun(),
        spec: sampleSpec(),
        verdict: sampleVerdict(),
        worktreePath: '/tmp',
      }),
    ).toBe('Add a passing test for foo');
  });
});

describe('defaultBuildBody', () => {
  const input = {
    run: sampleRun(),
    spec: sampleSpec(),
    verdict: sampleVerdict(),
    worktreePath: '/tmp',
  };

  it('includes a Summary section with the description', () => {
    const b = defaultBuildBody(input);
    expect(b).toContain('## Summary');
    expect(b).toContain('The foo function needs a passing unit test.');
  });

  it('lists acceptance criteria', () => {
    expect(defaultBuildBody(input)).toContain('- Tests pass');
  });

  it('reports verification with each test command', () => {
    const b = defaultBuildBody(input);
    expect(b).toContain('## Verification');
    expect(b).toContain('All test commands passed.');
    expect(b).toContain('`pnpm test` — exit 0');
  });

  it('shows "did not pass" when verdict.pass is false', () => {
    const failed: Verdict = { ...sampleVerdict(), pass: false };
    const b = defaultBuildBody({ ...input, verdict: failed });
    expect(b).toContain('Verification did not pass.');
  });

  it('includes the run id', () => {
    expect(defaultBuildBody(input)).toContain('Run id: run-1');
  });
});

describe('GhPrOpener: happy path', () => {
  it('pushes the branch then creates the PR and returns the URL', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: PrRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git') return fakeOk();
      if (cmd === 'gh')
        return fakeOk('https://github.com/foo/bar/pull/42\n');
      return fakeFail('unexpected');
    };
    const opener = new GhPrOpener({ runner });
    const result = await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(result).toEqual({ ok: true, url: 'https://github.com/foo/bar/pull/42' });

    expect(calls[0]?.cmd).toBe('git');
    expect(calls[0]?.args).toEqual(['push', '-u', 'origin', 'agent/run-1']);
    expect(calls[1]?.cmd).toBe('gh');
    expect(calls[1]?.args.slice(0, 6)).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'agent/run-1',
    ]);
  });

  it('passes the built title and body to gh', async () => {
    let capturedTitle = '';
    let capturedBody = '';
    const runner: PrRunner = async (cmd, args) => {
      if (cmd === 'gh') {
        const tIdx = args.indexOf('--title');
        const bIdx = args.indexOf('--body');
        capturedTitle = args[tIdx + 1] ?? '';
        capturedBody = args[bIdx + 1] ?? '';
        return fakeOk('https://github.com/foo/bar/pull/1\n');
      }
      return fakeOk();
    };
    const opener = new GhPrOpener({ runner });
    await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(capturedTitle).toBe('Add a passing test for foo');
    expect(capturedBody).toContain('## Summary');
    expect(capturedBody).toContain('Run id: run-1');
  });

  it('honors a custom baseBranch', async () => {
    let captured: string[] = [];
    const runner: PrRunner = async (cmd, args) => {
      if (cmd === 'gh') captured = args;
      return cmd === 'gh' ? fakeOk('https://github.com/x/y/pull/1\n') : fakeOk();
    };
    const opener = new GhPrOpener({ runner, baseBranch: 'develop' });
    await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(captured.slice(0, 4)).toEqual(['pr', 'create', '--base', 'develop']);
  });
});

describe('GhPrOpener: failure paths', () => {
  it('returns ok=false when git push exits non-zero', async () => {
    const runner: PrRunner = async (cmd) =>
      cmd === 'git' ? fakeFail('remote rejected', 1) : fakeOk();
    const opener = new GhPrOpener({ runner });
    const result = await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('git push failed');
      expect(result.error).toContain('remote rejected');
    }
  });

  it('does not call gh when push fails', async () => {
    let ghCalled = false;
    const runner: PrRunner = async (cmd) => {
      if (cmd === 'gh') ghCalled = true;
      return cmd === 'git' ? fakeFail('nope') : fakeOk();
    };
    const opener = new GhPrOpener({ runner });
    await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(ghCalled).toBe(false);
  });

  it('returns ok=false when gh pr create exits non-zero', async () => {
    const runner: PrRunner = async (cmd) =>
      cmd === 'gh' ? fakeFail('not authenticated', 4) : fakeOk();
    const opener = new GhPrOpener({ runner });
    const result = await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('gh pr create failed');
    }
  });

  it('returns ok=false when gh stdout has no parseable URL', async () => {
    const runner: PrRunner = async (cmd) => {
      if (cmd === 'gh') return fakeOk('nothing useful\nstill nothing');
      return fakeOk();
    };
    const opener = new GhPrOpener({ runner });
    const result = await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not parse PR URL');
    }
  });

  it('treats a spawnFailed result as failure', async () => {
    const runner: PrRunner = async (cmd) => {
      if (cmd === 'git') {
        return {
          command: 'git',
          args: [],
          exitCode: -1,
          stdout: '',
          stderr: 'spawn ENOENT',
          durationMs: 1,
          timedOut: false,
          spawnFailed: true,
        };
      }
      return fakeOk();
    };
    const opener = new GhPrOpener({ runner });
    const result = await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: '/tmp',
    });
    expect(result.ok).toBe(false);
  });
});

describe('GhPrOpener: live gh integration', () => {
  // Opt-in. Real `gh` calls cost a real PR; we don't want that in CI.
  const skip =
    process.env['AGENT_LOOP_LIVE_PR'] !== '1';
  it.skipIf(skip)('opens a real PR against the live gh CLI', async () => {
    const opener = new GhPrOpener();
    const result = await opener.openPullRequest({
      run: sampleRun(),
      spec: sampleSpec(),
      verdict: sampleVerdict(),
      worktreePath: process.cwd(),
    });
    expect(result.ok).toBe(true);
  });
});
