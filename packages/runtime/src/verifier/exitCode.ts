/**
 * Exit-code verifier (week 2).
 *
 * Runs each command in `spec.testCommands` sequentially in the worktree
 * and aggregates the results into a Verdict. A command is wrapped in
 * `bash -c` so that the spec can use shell features (pipes, redirects,
 * environment variables) without us parsing.
 *
 * Aggregation rules:
 * - `verdict.pass` is true iff every test command exited with code 0.
 * - All commands run even if an earlier one failed — more signal in the
 *   artifacts, and per-test results matter for triage.
 * - Empty testCommands list yields pass=true with no test results.
 *
 * The LLM semantic check (does the diff match the spec?) does not exist
 * yet in week 2. We stub semanticCheck to matches=true with a reasoning
 * string that names the stub explicitly — week 3 will replace it.
 */

import {
  type Run,
  type Spec,
  type Verdict,
  type TestResult,
  type Logger,
} from '@agent-loop/core';
import { runCommand } from '../proc/run.js';

export interface VerifyOptions {
  /** Working directory in which to run each command. */
  cwd: string;
  logger?: Logger;
  now?: () => string;
  /** Per-command wall-clock budget. Defaults to spec.budget.maxSeconds. */
  timeoutMsPerCommand?: number;
}

const OUTPUT_HEAD_BYTES = 4096;
const OUTPUT_TAIL_BYTES = 4096;

export async function runExitCodeVerifier(
  run: Run,
  spec: Spec,
  options: VerifyOptions,
): Promise<Verdict> {
  const now = options.now ?? ((): string => new Date().toISOString());
  const timeoutMs =
    options.timeoutMsPerCommand ?? spec.budget.maxSeconds * 1000;

  const testResults: TestResult[] = [];
  let allPassed = true;

  for (const command of spec.testCommands) {
    options.logger?.info('verifier: running test command', {
      runId: run.id,
      command,
    });

    const res = await runCommand('bash', ['-c', command], {
      cwd: options.cwd,
      timeoutMs,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });

    const passed = res.exitCode === 0 && !res.timedOut && !res.spawnFailed;
    if (!passed) allPassed = false;

    testResults.push({
      command,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      outputSummary: summarizeOutput(res.stdout, res.stderr, {
        timedOut: res.timedOut,
        spawnFailed: res.spawnFailed,
      }),
    });
  }

  return {
    runId: run.id,
    pass: allPassed,
    testResults,
    semanticCheck: {
      matches: true,
      reasoning:
        'exit-code verifier (week 2): semantic LLM check not yet implemented',
    },
    createdAt: now(),
  };
}

/**
 * Combine stdout and stderr, then truncate to first/last 4KB if oversized.
 * Slicing is by JS string units, not bytes — fine for the ASCII test logs
 * we expect; multi-byte chars near the boundary may produce a slightly
 * different head/tail size than 4KB exactly.
 */
export function summarizeOutput(
  stdout: string,
  stderr: string,
  flags: { timedOut: boolean; spawnFailed: boolean } = {
    timedOut: false,
    spawnFailed: false,
  },
): string {
  const prefix: string[] = [];
  if (flags.timedOut) prefix.push('[timed out]');
  if (flags.spawnFailed) prefix.push('[spawn failed]');

  const combined = [
    stdout,
    stderr ? `--- stderr ---\n${stderr}` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');

  const body =
    combined.length <= OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES
      ? combined
      : combined.slice(0, OUTPUT_HEAD_BYTES) +
        '\n... [truncated] ...\n' +
        combined.slice(-OUTPUT_TAIL_BYTES);

  return prefix.length > 0 ? `${prefix.join(' ')}\n${body}` : body;
}
