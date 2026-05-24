/**
 * Calibration anchor — side-channel comparison between the new semantic
 * verifier and the deprecated shell testCommands. Signal only: the
 * semantic verdict is authoritative for the run's pass/fail. Disagreements
 * are warn-logged and surfaced in the eval report. Removal is gated on
 * BACKLOG#gap-calibration-anchor-removal — one full eval suite run with
 * 0/M disagreements.
 *
 * Active only when:
 *   - opts.calibrationMode === true (set by the eval drive when invoked
 *     with --calibration-mode; never set in production)
 *   - opts.calibrationTestCommands is non-empty
 *
 * When inactive, every caller path leaves Verdict.calibrationAnchor
 * undefined and runs zero anchor commands. This invariant is tested in
 * runVerifier.test.ts.
 */

import type { CalibrationAnchorResult, Logger } from '@agent-loop/core';
import { runCommand, type RunCommandResult } from '../proc/run.js';

export type AnchorRunner = (
  command: string,
  args: string[],
  options?: Parameters<typeof runCommand>[2],
) => Promise<RunCommandResult>;

export interface CalibrationAnchorOptions {
  /** Working directory. Same as the verifier's cwd. */
  cwd: string;
  /** Whether to override the default real runCommand (testing seam). */
  runner?: AnchorRunner;
  /** Per-command wall-clock cap. Mirrors the exit-code verifier's default. */
  timeoutMsPerCommand?: number;
  logger?: Logger;
}

/**
 * Compute the semantic verifier's pass/fail in the same shape as the anchor
 * for the agreement comparison. We pass both the exit-code result and the
 * semantic result to derive the overall pass cleanly.
 */
export interface SemanticOutcome {
  exitCodePass: boolean;
  semanticMatches: boolean;
}

export async function runCalibrationAnchor(
  commands: ReadonlyArray<string>,
  semantic: SemanticOutcome,
  options: CalibrationAnchorOptions,
): Promise<CalibrationAnchorResult> {
  const runner = options.runner ?? runCommand;
  const timeoutMs = options.timeoutMsPerCommand ?? 60_000;

  const exitCodes: number[] = [];
  for (const command of commands) {
    const res = await runner('bash', ['-c', command], {
      cwd: options.cwd,
      timeoutMs,
    });
    exitCodes.push(res.exitCode);
  }
  const anchorPass = exitCodes.every((c) => c === 0);

  const verdictPass = semantic.exitCodePass && semantic.semanticMatches;
  const agreement = anchorPass === verdictPass;

  if (!agreement) {
    const direction =
      anchorPass && !verdictPass
        ? 'anchor=pass, semantic=fail'
        : 'anchor=fail, semantic=pass POTENTIAL FALSE POSITIVE';
    options.logger?.warn('verifier: calibration disagreement', {
      direction,
      anchorPass,
      semanticPass: verdictPass,
      commands: [...commands],
      exitCodes,
    });
  }

  return {
    commands: [...commands],
    exitCodes,
    anchorPass,
    agreement,
  };
}
