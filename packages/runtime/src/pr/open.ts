/**
 * GhPrOpener: opens a GitHub pull request by pushing the worktree's branch
 * and invoking `gh pr create`.
 *
 * Flow:
 *   1. `git push -u origin <branch>` from the worktree
 *   2. `gh pr create --base <base> --title <title> --body <body>` from the
 *      worktree
 *   3. Parse the PR URL from gh's stdout (last URL-looking line)
 *
 * The proc runner is injectable so unit tests can supply a fake without
 * spawning real binaries. The default uses runCommand. A live test against
 * real `git`/`gh` is opt-in via the AGENT_LOOP_LIVE_PR env flag.
 *
 * Authentication is the caller's concern: `gh auth login` must have been
 * run, and the worktree's remote must allow push. We don't manage credentials.
 */

import type { PrOpener, PrOpenInput, PrOpenResult } from './types.js';
import { runCommand, type RunCommandResult } from '../proc/run.js';

export type PrRunner = (
  command: string,
  args: string[],
  options?: Parameters<typeof runCommand>[2],
) => Promise<RunCommandResult>;

export interface GhPrOpenerOptions {
  gitBinary?: string;
  ghBinary?: string;
  /** Target branch. Defaults to "main". */
  baseBranch?: string;
  /** Override the title generator (pure function over the input). */
  buildTitle?: (input: PrOpenInput) => string;
  /** Override the body generator. */
  buildBody?: (input: PrOpenInput) => string;
  /** Injectable proc runner; defaults to runCommand. Used by tests. */
  runner?: PrRunner;
}

export class GhPrOpener implements PrOpener {
  private readonly gitBinary: string;
  private readonly ghBinary: string;
  private readonly baseBranch: string;
  private readonly buildTitle: (input: PrOpenInput) => string;
  private readonly buildBody: (input: PrOpenInput) => string;
  private readonly runner: PrRunner;

  constructor(opts: GhPrOpenerOptions = {}) {
    this.gitBinary = opts.gitBinary ?? 'git';
    this.ghBinary = opts.ghBinary ?? 'gh';
    this.baseBranch = opts.baseBranch ?? 'main';
    this.buildTitle = opts.buildTitle ?? defaultBuildTitle;
    this.buildBody = opts.buildBody ?? defaultBuildBody;
    this.runner = opts.runner ?? runCommand;
  }

  async openPullRequest(input: PrOpenInput): Promise<PrOpenResult> {
    const log = input.logger;
    const cwd = input.worktreePath;

    log?.info('pr: pushing branch', { runId: input.run.id, branch: input.run.branch });
    const push = await this.runner(
      this.gitBinary,
      ['push', '-u', 'origin', input.run.branch],
      {
        cwd,
        ...(log !== undefined ? { logger: log } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
    );
    if (push.exitCode !== 0 || push.spawnFailed || push.timedOut) {
      return {
        ok: false,
        error: `git push failed (exit ${push.exitCode}): ${truncate(push.stderr || push.stdout, 500)}`,
      };
    }

    const title = this.buildTitle(input);
    const body = this.buildBody(input);
    log?.info('pr: creating', { runId: input.run.id, title });
    const create = await this.runner(
      this.ghBinary,
      [
        'pr',
        'create',
        '--base',
        this.baseBranch,
        '--head',
        input.run.branch,
        '--title',
        title,
        '--body',
        body,
      ],
      {
        cwd,
        ...(log !== undefined ? { logger: log } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
    );
    if (create.exitCode !== 0 || create.spawnFailed || create.timedOut) {
      return {
        ok: false,
        error: `gh pr create failed (exit ${create.exitCode}): ${truncate(create.stderr || create.stdout, 500)}`,
      };
    }

    const url = parsePrUrl(create.stdout);
    if (!url) {
      return {
        ok: false,
        error: `could not parse PR URL from gh output: ${truncate(create.stdout, 500)}`,
      };
    }
    log?.info('pr: opened', { runId: input.run.id, url });
    return { ok: true, url };
  }
}

// --- Pure helpers ----------------------------------------------------------

export function defaultBuildTitle(input: PrOpenInput): string {
  return input.spec.title;
}

export function defaultBuildBody(input: PrOpenInput): string {
  const lines: string[] = [];
  lines.push('## Summary');
  lines.push(input.spec.description.trim());
  lines.push('');

  if (input.spec.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria');
    for (const ac of input.spec.acceptanceCriteria) {
      lines.push(`- ${ac}`);
    }
    lines.push('');
  }

  lines.push('## Verification');
  lines.push(
    input.verdict.pass
      ? 'All test commands passed.'
      : 'Verification did not pass.',
  );
  const BT = String.fromCharCode(96); // backtick — avoid template-literal escape
  for (const tr of input.verdict.testResults) {
    lines.push(
      `- ${BT}${tr.command}${BT} — exit ${tr.exitCode}, ${tr.durationMs}ms`,
    );
  }
  lines.push('');
  lines.push(`Run id: ${input.run.id}`);
  return lines.join('\n');
}

/**
 * gh pr create prints the PR URL on the final line. We match the URL with
 * a regex (host followed by /pull/<number>) to be robust to GHES, custom
 * hostnames, and any extra noise gh might print on earlier lines
 * (warnings, hints, etc).
 */
export function parsePrUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/\S+\/pull\/\d+/);
  return match ? match[0] : null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '... [truncated]';
}
