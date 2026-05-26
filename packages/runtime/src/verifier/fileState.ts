/**
 * runFileStateChecks — mechanical verification of triage's
 * fileStateChecks. Each FileStateCheck translates to a deterministic
 * shell command; the verifier runs each, aggregates exit codes,
 * returns pass/fail per check + a combined result.
 *
 * Per Option E (docs/triage-file-reference-rethink.md): file-state
 * claims belong in fileStateChecks where they're mechanically
 * verifiable, not in acceptanceCriteria where the semantic verifier's
 * "diff is universe of changes" rule would block judgment on files
 * the agent didn't touch.
 *
 * Type → shell translation:
 *   - unchanged → `git diff --quiet main -- <path>` (exit 0 = no changes)
 *   - deleted   → `test ! -f <path>`               (exit 0 = file absent)
 *   - exists    → `test -f <path>`                 (exit 0 = file present)
 *   - absent    → `test ! -f <path>`               (exit 0 = file absent)
 *
 * `deleted` and `absent` are semantically distinct in the triage prompt
 * (deleted means "previously existed, now gone"; absent means "never
 * existed") but verify the same way mechanically. The semantic
 * distinction lives in the criterion's authorship — the verifier
 * doesn't need pre-edit state.
 */

import type { FileStateCheck, Logger } from '@agent-loop/core';
import { runCommand, type RunCommandResult } from '../proc/run.js';

export type FileStateRunner = (
  command: string,
  args: string[],
  options?: Parameters<typeof runCommand>[2],
) => Promise<RunCommandResult>;

export interface FileStateRunOptions {
  cwd: string;
  baseRef?: string; // default 'main'
  runner?: FileStateRunner;
  timeoutMsPerCheck?: number;
  logger?: Logger;
}

export interface FileStateCheckResult {
  check: FileStateCheck;
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  outputSummary: string;
}

export interface FileStateRunResult {
  /** True iff every check passed. */
  pass: boolean;
  /** One result per check, same order as input. */
  results: FileStateCheckResult[];
}

export async function runFileStateChecks(
  checks: ReadonlyArray<FileStateCheck>,
  options: FileStateRunOptions,
): Promise<FileStateRunResult> {
  const runner = options.runner ?? runCommand;
  const baseRef = options.baseRef ?? 'main';
  const timeoutMs = options.timeoutMsPerCheck ?? 30_000;

  const results: FileStateCheckResult[] = [];
  let allPass = true;

  for (const check of checks) {
    const { argv, displayCommand } = translate(check, baseRef);
    options.logger?.info('file-state: running check', {
      type: check.type,
      path: check.path,
      command: displayCommand,
    });

    const res = await runner(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      timeoutMs,
    });

    const passed =
      res.exitCode === 0 && !res.timedOut && !res.spawnFailed;
    if (!passed) allPass = false;

    results.push({
      check,
      command: displayCommand,
      exitCode: res.exitCode,
      passed,
      durationMs: res.durationMs,
      outputSummary: summarize(res),
    });
  }

  return { pass: allPass, results };
}

function translate(
  check: FileStateCheck,
  baseRef: string,
): { argv: string[]; displayCommand: string } {
  switch (check.type) {
    case 'unchanged':
      return {
        argv: ['git', 'diff', '--quiet', baseRef, '--', check.path],
        displayCommand: `git diff --quiet ${baseRef} -- ${check.path}`,
      };
    case 'deleted':
    case 'absent':
      return {
        argv: ['sh', '-c', `test ! -f ${shellQuote(check.path)}`],
        displayCommand: `test ! -f ${check.path}`,
      };
    case 'exists':
      return {
        argv: ['sh', '-c', `test -f ${shellQuote(check.path)}`],
        displayCommand: `test -f ${check.path}`,
      };
  }
}

/**
 * Minimal single-quote shell-quote for paths. Paths in fileStateChecks
 * are validated non-empty strings; we don't expect shell metacharacters
 * in normal use but defending against them costs nothing. The validator
 * doesn't reject paths with shell-special chars (they're valid POSIX
 * filenames); the quoting handles them at the execution layer.
 */
function shellQuote(s: string): string {
  // Wrap in single quotes; escape embedded single quotes by closing,
  // injecting an escaped quote, and reopening.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function summarize(res: RunCommandResult): string {
  const flags: string[] = [];
  if (res.timedOut) flags.push('[timed out]');
  if (res.spawnFailed) flags.push('[spawn failed]');
  const out = [res.stdout, res.stderr ? `--- stderr ---\n${res.stderr}` : '']
    .filter((s) => s.length > 0)
    .join('\n');
  return flags.length > 0 ? `${flags.join(' ')}\n${out}` : out;
}
