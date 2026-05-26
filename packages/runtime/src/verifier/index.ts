/**
 * runVerifier — top-level entry point composing exit-code + semantic
 * verification into a single Verdict.
 *
 * Order of operations:
 *   1. runExitCodeVerifier: runs every spec.testCommand sequentially. If
 *      any fails, the verdict is `pass: false` and semantic verification
 *      is SKIPPED (no SDK call, no extra cost). Semantic check is set to
 *      a sentinel indicating it was not run.
 *   2. If all test commands passed, runSemanticVerifier judges each
 *      acceptance criterion against the diff. The verdict's `pass` is
 *      then `exit-code-pass AND semantic.matches`.
 *
 * The composer also propagates `usages: TokenUsage[]` from the semantic
 * verifier (Path A in the design — the caller in tickVerifying applies
 * record_token_usage events).
 *
 * (Earlier versions of this module also ran a calibration anchor as a
 * side-channel comparison against the deprecated shell testCommands.
 * The anchor served its purpose during the triage↔verifier refactor —
 * one full eval-suite run with 0/M disagreements proved the semantic
 * verifier was correctly calibrated — and was then removed per
 * BACKLOG#gap-calibration-anchor-removal. See commit history for the
 * anchor's life cycle.)
 */

import {
  type Run,
  type Spec,
  type Verdict,
  type Logger,
  type TokenUsage,
} from '@agent-loop/core';
import { runExitCodeVerifier, type VerifyOptions } from './exitCode.js';
import {
  runSemanticVerifier,
  type SemanticOnSdkError,
} from './semantic.js';
import type { SemanticDebug } from './semanticSchema.js';
import type { AnthropicClient } from '../agents/sdkClient.js';
import { getDiffSinceBase, type DiffRunner } from '../git/diff.js';
import {
  runFileStateChecks,
  type FileStateRunResult,
  type FileStateRunner,
} from './fileState.js';

export { runExitCodeVerifier } from './exitCode.js';
export {
  runSemanticVerifier,
  DEFAULT_SEMANTIC_MODEL,
} from './semantic.js';
export type {
  SemanticVerifierDeps,
  SemanticVerifierInput,
  SemanticVerifierOptions,
  SemanticVerifierResult,
  SemanticOnSdkError,
} from './semantic.js';
export type { VerifyOptions } from './exitCode.js';

export interface RunVerifierOptions extends VerifyOptions {
  /** Anthropic client for the semantic step. Required to enable semantic. */
  client?: AnthropicClient;
  /** Model override for the semantic verifier. */
  semanticModel?: string;
  /** What to do on SDK error in the semantic step. Default 'strict'. */
  semanticOnSdkError?: SemanticOnSdkError;
  /** Base ref for the diff (typically 'main'). Default 'main'. */
  baseRef?: string;
  /** Git diff runner override (testing seam). */
  diffRunner?: DiffRunner;
  /** Override the file-state runner (testing seam). */
  fileStateRunner?: FileStateRunner;
}

export interface RunVerifierResult {
  verdict: Verdict;
  /**
   * Token usages from the semantic verifier (empty if not called).
   * The caller (tickVerifying) applies record_token_usage events.
   */
  usages: TokenUsage[];
  /**
   * Debug payload from the semantic verifier when at least one
   * validation failure occurred (call 1 invalid, regardless of call 2).
   * Caller persists it as verdict-NNN.semantic-debug.json so we can
   * inspect what shape the model produced and why the validator
   * rejected it. Absent on clean happy-path runs.
   */
  semanticDebug?: SemanticDebug;
  /**
   * Result of the file-state checks (Option E). Populated whenever the
   * spec has fileStateChecks — empty checks → empty results, pass:true.
   * Surfaced separately from the Verdict so callers can inspect each
   * check's exit code independently of the aggregated pass/fail.
   */
  fileStateResult?: FileStateRunResult;
}

export async function runVerifier(
  run: Run,
  spec: Spec,
  options: RunVerifierOptions,
): Promise<RunVerifierResult> {
  const logger: Logger | undefined = options.logger;

  // Per Option E signoff 3: run exit-code, fileState, AND semantic
  // unconditionally on every call (no short-circuit). The verdict's
  // pass is true only when ALL THREE gates pass. Running all three
  // gives complete diagnostic data — if fileState fails we still want
  // to see the semantic verifier's per-criterion judgment about the
  // diff, and vice versa.

  // Gate 1: exit-code tests.
  const exitVerdict = await runExitCodeVerifier(run, spec, options);

  // Gate 2: fileStateChecks. Always invoked; degenerate (no checks)
  // yields pass=true, results=[].
  const fileStateResult = await runFileStateChecks(
    spec.fileStateChecks ?? [],
    {
      cwd: options.cwd,
      ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
      ...(options.fileStateRunner !== undefined
        ? { runner: options.fileStateRunner }
        : {}),
      ...(logger !== undefined ? { logger } : {}),
    },
  );

  // Gate 3: semantic verifier. Conditional on having a client AND
  // having acceptanceCriteria to judge. The conditions are about
  // CAPABILITY, not about the run's outcome; both gates above ran
  // either way.
  const shouldRunSemantic =
    options.client !== undefined && spec.acceptanceCriteria.length > 0;

  let usages: TokenUsage[] = [];
  let semanticDebug: SemanticDebug | undefined;
  let semanticReasoning: string;
  let semanticMatches: boolean;
  let perCriterion: ReturnType<typeof toPerCriterion> = [];

  if (!shouldRunSemantic) {
    semanticMatches = true; // trivially passes when nothing to judge
    semanticReasoning =
      options.client === undefined
        ? 'semantic verifier disabled: no Anthropic client provided'
        : 'no acceptance criteria; semantic verifier had nothing to judge';
    if (options.client === undefined) {
      logger?.warn('verifier: no Anthropic client provided; running exit-code + fileState only', {
        runId: run.id,
      });
    }
  } else {
    const diff = await getDiffSinceBase({
      cwd: options.cwd,
      baseRef: options.baseRef ?? 'main',
      ...(options.diffRunner !== undefined ? { runner: options.diffRunner } : {}),
    });

    const semantic = await runSemanticVerifier(
      {
        client: options.client!,
        ...(logger !== undefined ? { logger } : {}),
        ...(options.semanticModel !== undefined
          ? { model: options.semanticModel }
          : {}),
      },
      {
        diff,
        acceptanceCriteria: spec.acceptanceCriteria,
      },
      options.semanticOnSdkError !== undefined
        ? { onSdkError: options.semanticOnSdkError }
        : {},
    );

    usages = [...semantic.usages];

    if (!semantic.ok) {
      // Whole-task SDK-error skip (onSdkError === 'skip' AND every call
      // SDK-errored). Treat semantic as not-blocking on this run.
      logger?.warn(
        'verifier: semantic step skipped due to SDK error',
        { runId: run.id, message: semantic.message },
      );
      semanticMatches = true; // not contributing to pass=false
      semanticReasoning = `semantic step skipped: ${semantic.message}`;
    } else {
      semanticMatches = semantic.matches;
      semanticReasoning = summarizeReasoning(
        semantic.perCriterion,
        semantic.verifierErrors,
        semantic.diffTruncated,
      );
      perCriterion = toPerCriterion(semantic.perCriterion);
      if (semantic.debug !== undefined) semanticDebug = semantic.debug;
    }
  }

  // Compose the final verdict. pass requires ALL THREE gates to pass.
  const pass = exitVerdict.pass && fileStateResult.pass && semanticMatches;
  const composedReasoning = composeReasoning(
    exitVerdict.pass,
    fileStateResult,
    semanticReasoning,
  );

  const verdict: Verdict = {
    ...exitVerdict,
    pass,
    semanticCheck: {
      matches: semanticMatches,
      reasoning: composedReasoning,
      ...(perCriterion.length > 0 ? { perCriterion } : {}),
    },
  };

  const result: RunVerifierResult = {
    verdict,
    usages,
    fileStateResult,
  };
  if (semanticDebug !== undefined) result.semanticDebug = semanticDebug;
  return result;
}

function toPerCriterion(
  judgments: ReadonlyArray<{ criterion: string; met: boolean; reasoning: string }>,
): Array<{ criterion: string; met: boolean; reasoning: string }> {
  return judgments.map((c) => ({
    criterion: c.criterion,
    met: c.met,
    reasoning: c.reasoning,
  }));
}

/**
 * Build the verdict's reasoning string. The semantic reasoning is the
 * base; file-state failures get appended; exit-code failures are
 * implicit in the testResults.
 */
function composeReasoning(
  exitCodePass: boolean,
  fileState: FileStateRunResult,
  semanticReasoning: string,
): string {
  const parts: string[] = [];
  if (!exitCodePass) {
    parts.push('exit-code tests failed');
  }
  if (!fileState.pass) {
    const failed = fileState.results.filter((r) => !r.passed);
    const detail = failed
      .map((r) => `\`${r.command}\` (exit ${r.exitCode})`)
      .join(', ');
    parts.push(`file-state failures: ${detail}`);
  }
  parts.push(semanticReasoning);
  return parts.join(' | ');
}

function skippedSemantic(exitVerdict: Verdict, reasoning: string): Verdict {
  return {
    ...exitVerdict,
    semanticCheck: { matches: exitVerdict.pass, reasoning },
  };
}

function summarizeReasoning(
  judgments: ReadonlyArray<{ met: boolean }>,
  verifierErrors: ReadonlyArray<{ criterion: string; reason: string; message: string }>,
  diffTruncated: boolean,
): string {
  const met = judgments.filter((c) => c.met).length;
  const totalAttempted = judgments.length + verifierErrors.length;
  const prefix = diffTruncated ? '[diff truncated] ' : '';
  if (verifierErrors.length === 0) {
    return `${prefix}${met}/${totalAttempted} acceptance criteria met`;
  }
  const errorDetail = verifierErrors
    .map((e) => `"${e.criterion}" (${e.reason})`)
    .join(', ');
  return `${prefix}${met}/${totalAttempted} acceptance criteria met; ${verifierErrors.length} verifier error(s): ${errorDetail}`;
}
