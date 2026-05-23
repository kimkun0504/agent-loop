/**
 * ClaudeCliExecutor: spawns the `claude` CLI in the worktree to drive the
 * agent against a spec.
 *
 * Week 2 wiring is intentionally minimal:
 *   - `claude -p <prompt>` runs the agent in non-interactive print mode.
 *   - We use `--permission-mode acceptEdits` so the agent can edit files
 *     without an interactive prompt. The agent is sandboxed by the worktree
 *     (worktree isolation is the safety layer that's load-bearing here;
 *     Docker comes in week 3).
 *   - Wall-clock budget comes from spec.budget.maxSeconds.
 *
 * The binary name and any extra args are configurable on the constructor
 * so tests can substitute a fake binary (we use `bash` as a stand-in) and
 * future code can route through Docker or an SDK call without rewriting
 * the executor port.
 *
 * The Anthropic API key (or whatever auth the local `claude` install uses)
 * is the user's concern — we don't manage credentials here.
 */

import type { Executor, ExecutorInput, ExecutorResult } from './types.js';
import { runCommand } from '../proc/run.js';
import { buildExecutorPrompt } from './prompt.js';
import { parseClaudeJsonOutput } from './claudeOutput.js';

export interface ClaudeCliExecutorOptions {
  /** Path to the `claude` binary. Defaults to "claude" (must be on PATH). */
  binary?: string;
  /**
   * Extra args inserted before `-p <prompt>`. Defaults to enabling
   * non-interactive edit permissions inside the worktree.
   */
  extraArgs?: string[];
  /** Override the prompt builder. Useful for tests. */
  buildPrompt?: (input: ExecutorInput) => string;
}

const DEFAULT_BINARY = 'claude';
const DEFAULT_EXTRA_ARGS: ReadonlyArray<string> = [
  '--permission-mode',
  'acceptEdits',
  // Switch to JSON output so we can parse usage / cost. The output is a
  // single JSON object on stdout; see src/executor/claudeOutput.ts.
  '--output-format',
  'json',
];

export class ClaudeCliExecutor implements Executor {
  private readonly binary: string;
  private readonly extraArgs: ReadonlyArray<string>;
  private readonly buildPrompt: (input: ExecutorInput) => string;

  constructor(opts: ClaudeCliExecutorOptions = {}) {
    this.binary = opts.binary ?? DEFAULT_BINARY;
    this.extraArgs = opts.extraArgs ?? DEFAULT_EXTRA_ARGS;
    this.buildPrompt = opts.buildPrompt ?? ((i) => buildExecutorPrompt(i.spec));
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const prompt = this.buildPrompt(input);
    const args = [...this.extraArgs, '-p', prompt];
    const timeoutMs = input.spec.budget.maxSeconds * 1000;

    input.logger?.info('executor: launching agent', {
      runId: input.run.id,
      binary: this.binary,
      worktree: input.worktreePath,
      timeoutMs,
    });

    const result = await runCommand(this.binary, args, {
      cwd: input.worktreePath,
      timeoutMs,
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    const outputLog =
      result.stdout +
      (result.stderr ? `\n--- stderr ---\n${result.stderr}` : '');

    const ok =
      !result.timedOut && !result.spawnFailed && result.exitCode === 0;

    // Best-effort usage extraction. parseClaudeJsonOutput returns null on
    // any structural mismatch; we log a warn and let usage stay undefined
    // rather than failing the run (a missing token count shouldn't break
    // execution; the budget check downstream will simply not fire).
    const summary = ok ? parseClaudeJsonOutput(result.stdout) : null;
    if (ok && !summary) {
      input.logger?.warn('executor: could not parse claude JSON output', {
        runId: input.run.id,
        stdoutBytes: result.stdout.length,
      });
    }

    input.logger?.info('executor: agent finished', {
      runId: input.run.id,
      ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      spawnFailed: result.spawnFailed,
      inputTokens: summary?.usage.inputTokens,
      outputTokens: summary?.usage.outputTokens,
      costUsd: summary?.usage.costUsd,
    });

    const out: ExecutorResult = {
      ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputLog,
      timedOut: result.timedOut,
      spawnFailed: result.spawnFailed,
    };
    if (summary) out.usage = summary.usage;
    return out;
  }
}
