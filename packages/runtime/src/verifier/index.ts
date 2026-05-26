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
    return {
      verdict: skippedSemantic(
        exitVerdict,
        'exit-code tests failed; semantic verification skipped (fail-closed at exit-code gate)',
      ),
      usages: [],
    };
  }

  if (!options.client) {
    logger?.warn(
      'verifier: no Anthropic client provided; running exit-code only',
      { runId: run.id },
    );
    return {
      verdict: skippedSemantic(
        exitVerdict,
        'semantic verifier disabled: no Anthropic client provided',
      ),
      usages: [],
    };
  }

  if (spec.acceptanceCriteria.length === 0) {
    logger?.info('verifier: spec has no acceptance criteria; semantic step trivially passes', {
      runId: run.id,
    });
    return {
      verdict: skippedSemantic(
        exitVerdict,
        'no acceptance criteria; semantic verifier had nothing to judge',
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
      return {
        verdict: skippedSemantic(
          exitVerdict,
          `semantic step skipped: ${semantic.message}`,
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
    const result: RunVerifierResult = {
      verdict: failed,
      usages: semantic.usages,
    };
    if (semantic.debug !== undefined) result.semanticDebug = semantic.debug;
    return result;
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
  const result: RunVerifierResult = {
    verdict: composed,
    usages: semantic.usages,
  };
  if (semantic.debug !== undefined) result.semanticDebug = semantic.debug;
  return result;
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
