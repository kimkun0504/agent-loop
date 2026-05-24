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
 * The calibration anchor (step 9) plugs in here: when enabled, it runs
 * the deprecated shell testCommands and attaches a CalibrationAnchorResult
 * to the verdict. This file gains the anchor wiring in step 9; the shape
 * is defined now (Path A returns usages, opts carries calibration config).
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
import type { AnthropicClient } from '../agents/sdkClient.js';
import { getDiffSinceBase, type DiffRunner } from '../git/diff.js';
import {
  runCalibrationAnchor,
  type AnchorRunner,
} from './calibrationAnchor.js';

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
  /**
   * Calibration mode — when true AND calibrationTestCommands is non-empty,
   * the deprecated shell commands run alongside the semantic verifier as
   * a side-channel anchor. Production runs leave this false. Set by the
   * eval drive when invoked with --calibration-mode.
   */
  calibrationMode?: boolean;
  /** Old shell testCommands kept as the calibration anchor. */
  calibrationTestCommands?: ReadonlyArray<string>;
  /** Calibration-anchor runner override (testing seam). */
  calibrationRunner?: AnchorRunner;
}

export interface RunVerifierResult {
  verdict: Verdict;
  /**
   * Token usages from the semantic verifier (empty if not called).
   * The caller (tickVerifying) applies record_token_usage events.
   */
  usages: TokenUsage[];
}

export async function runVerifier(
  run: Run,
  spec: Spec,
  options: RunVerifierOptions,
): Promise<RunVerifierResult> {
  const logger: Logger | undefined = options.logger;
  const exitVerdict = await runExitCodeVerifier(run, spec, options);

  if (!exitVerdict.pass) {
    logger?.info(
      'verifier: exit-code tests failed; skipping semantic verification',
      { runId: run.id },
    );
    const skipped = skippedSemantic(
      exitVerdict,
      'exit-code tests failed; semantic verification skipped (fail-closed at exit-code gate)',
    );
    // Run anchor even on exit-code fail — the disagreement signal is most
    // useful when one side fails and the other doesn't. The semantic side
    // didn't run, so we treat it as matching the exit-code outcome (false).
    return {
      verdict: await maybeAttachAnchor(
        skipped,
        { exitCodePass: false, semanticMatches: false },
        options,
      ),
      usages: [],
    };
  }

  if (!options.client) {
    logger?.warn(
      'verifier: no Anthropic client provided; running exit-code only',
      { runId: run.id },
    );
    const skipped = skippedSemantic(
      exitVerdict,
      'semantic verifier disabled: no Anthropic client provided',
    );
    return {
      verdict: await maybeAttachAnchor(
        skipped,
        { exitCodePass: true, semanticMatches: true },
        options,
      ),
      usages: [],
    };
  }

  if (spec.acceptanceCriteria.length === 0) {
    logger?.info('verifier: spec has no acceptance criteria; semantic step trivially passes', {
      runId: run.id,
    });
    const skipped = skippedSemantic(
      exitVerdict,
      'no acceptance criteria; semantic verifier had nothing to judge',
    );
    return {
      verdict: await maybeAttachAnchor(
        skipped,
        { exitCodePass: true, semanticMatches: true },
        options,
      ),
      usages: [],
    };
  }

  const diff = await getDiffSinceBase({
    cwd: options.cwd,
    baseRef: options.baseRef ?? 'main',
    ...(options.diffRunner !== undefined ? { runner: options.diffRunner } : {}),
  });

  const semantic = await runSemanticVerifier(
    {
      client: options.client,
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

  if (!semantic.ok) {
    if (semantic.reason === 'skipped') {
      // onSdkError === 'skip': accept the exit-code verdict alone.
      logger?.warn(
        'verifier: semantic step skipped due to SDK error; exit-code verdict stands',
        { runId: run.id, message: semantic.message },
      );
      const skipped = skippedSemantic(
        exitVerdict,
        `semantic step skipped: ${semantic.message}`,
      );
      return {
        verdict: await maybeAttachAnchor(
          skipped,
          { exitCodePass: true, semanticMatches: true },
          options,
        ),
        usages: semantic.usages,
      };
    }
    // sdk_error (strict) or invalid_output: fail the verdict.
    const failed: Verdict = {
      ...exitVerdict,
      pass: false,
      semanticCheck: {
        matches: false,
        reasoning: `semantic verifier failed (${semantic.reason}): ${semantic.message}`,
      },
    };
    return {
      verdict: await maybeAttachAnchor(
        failed,
        { exitCodePass: true, semanticMatches: false },
        options,
      ),
      usages: semantic.usages,
    };
  }

  const composed: Verdict = {
    ...exitVerdict,
    pass: exitVerdict.pass && semantic.matches,
    semanticCheck: {
      matches: semantic.matches,
      reasoning: summarizeReasoning(semantic.perCriterion, semantic.diffTruncated),
      perCriterion: semantic.perCriterion.map((c) => ({
        criterion: c.criterion,
        met: c.met,
        reasoning: c.reasoning,
      })),
    },
  };
  return {
    verdict: await maybeAttachAnchor(
      composed,
      { exitCodePass: exitVerdict.pass, semanticMatches: semantic.matches },
      options,
    ),
    usages: semantic.usages,
  };
}

async function maybeAttachAnchor(
  verdict: Verdict,
  outcome: { exitCodePass: boolean; semanticMatches: boolean },
  options: RunVerifierOptions,
): Promise<Verdict> {
  if (
    options.calibrationMode !== true ||
    !options.calibrationTestCommands ||
    options.calibrationTestCommands.length === 0
  ) {
    return verdict;
  }
  const anchor = await runCalibrationAnchor(
    options.calibrationTestCommands,
    outcome,
    {
      cwd: options.cwd,
      ...(options.calibrationRunner !== undefined
        ? { runner: options.calibrationRunner }
        : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    },
  );
  return { ...verdict, calibrationAnchor: anchor };
}

function skippedSemantic(exitVerdict: Verdict, reasoning: string): Verdict {
  return {
    ...exitVerdict,
    semanticCheck: { matches: exitVerdict.pass, reasoning },
  };
}

function summarizeReasoning(
  judgments: ReadonlyArray<{ met: boolean }>,
  diffTruncated: boolean,
): string {
  const met = judgments.filter((c) => c.met).length;
  const total = judgments.length;
  const prefix = diffTruncated ? '[diff truncated] ' : '';
  return `${prefix}${met}/${total} acceptance criteria met`;
}
