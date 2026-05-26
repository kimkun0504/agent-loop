/**
 * runSemanticVerifier — per-criterion implementation.
 *
 * The semantic verifier makes ONE Sonnet call per acceptance criterion
 * and aggregates the per-call judgments into a single result. The wire
 * format is one judgment object per call; there is no array shape on
 * the surface, which structurally eliminates the stringified-array
 * failure mode observed at CHECKPOINT 3.
 *
 * Hybrid execution: call 1 is serial (it establishes the Anthropic
 * prompt cache by writing a breakpoint after the system prompt + diff
 * portion of the user prompt). Calls 2..N run in parallel using
 * Promise.all; each reads the cache that call 1 wrote. Wall-clock per
 * task verifier phase: ~call_1_duration + max(parallel call durations)
 * ≈ ~10s, comparable to the single-call architecture's ~9s. Cost: see
 * docs/per-criterion-verifier-refactor.md §"Cost projection".
 *
 * Per-criterion failure isolation: a failed call (SDK error or invalid
 * output twice) does NOT abort the task. Other criteria continue. The
 * aggregator preserves the failure detail in `verifierErrors`; the
 * overall `matches` is false if any criterion is unmet OR any call
 * errored. Verdict.pass is `exitCodePass AND matches`.
 *
 * Whole-task SDK-error skip: if onSdkError === 'skip' AND every call
 * SDK-errored, the result is `ok: false reason: 'skipped'` and the
 * composer (runVerifier) treats the exit-code verdict as authoritative.
 * Otherwise, per-call SDK errors become per-criterion verifierErrors.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { type Logger, type TokenUsage } from '@agent-loop/core';
import type { AnthropicClient } from '../agents/sdkClient.js';
import { SONNET_PRICING } from '../agents/pricing.js';
import {
  SEMANTIC_INPUT_SCHEMA,
  SEMANTIC_TOOL_NAME,
  type PerCriterionJudgment,
  type VerifierError,
  type SemanticDebug,
  type SemanticDebugCall,
} from './semanticSchema.js';
import {
  SEMANTIC_SYSTEM_PROMPT,
  buildSemanticRetryUserPrompt,
  buildSemanticUserPrompt,
} from './semanticPrompt.js';
import { validateSingleJudgment } from './semanticValidate.js';

export const DEFAULT_SEMANTIC_MODEL = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 1_000;
const DIFF_CAP_BYTES = 30_000;
const TRUNCATION_MARKER = '\n... [truncated] ...';

export type SemanticOnSdkError = 'strict' | 'skip';

export interface SemanticVerifierDeps {
  client: AnthropicClient;
  logger?: Logger;
  model?: string;
}

export interface SemanticVerifierInput {
  diff: string;
  acceptanceCriteria: ReadonlyArray<string>;
}

export interface SemanticVerifierOptions {
  onSdkError?: SemanticOnSdkError;
}

export type SemanticVerifierResult =
  | {
      ok: true;
      matches: boolean;
      perCriterion: ReadonlyArray<PerCriterionJudgment>;
      verifierErrors: ReadonlyArray<VerifierError>;
      usages: TokenUsage[];
      diffTruncated: boolean;
      debug?: SemanticDebug;
    }
  | {
      ok: false;
      reason: 'skipped';
      message: string;
      usages: TokenUsage[];
    };

export async function runSemanticVerifier(
  deps: SemanticVerifierDeps,
  input: SemanticVerifierInput,
  options: SemanticVerifierOptions = {},
): Promise<SemanticVerifierResult> {
  const model = deps.model ?? DEFAULT_SEMANTIC_MODEL;
  const onSdkError: SemanticOnSdkError = options.onSdkError ?? 'strict';
  const { diff: cappedDiff, truncated } = capDiff(input.diff);

  deps.logger?.info('semantic-verifier: starting', {
    model,
    criteriaCount: input.acceptanceCriteria.length,
    diffBytes: cappedDiff.length,
    truncated,
  });

  if (input.acceptanceCriteria.length === 0) {
    // No criteria → no calls → trivially matches. The composer guards
    // against this case before calling us, but defensive return here.
    return {
      ok: true,
      matches: true,
      perCriterion: [],
      verifierErrors: [],
      usages: [],
      diffTruncated: truncated,
    };
  }

  // Call 1: serial. Establishes the prompt cache for calls 2..N.
  // The first call also pays the cache-write surcharge on the cached
  // prefix (~1.25× input cost on those tokens). Subsequent calls read
  // the cache at 0.1× input cost.
  const call1 = await callOne(
    deps,
    model,
    cappedDiff,
    input.acceptanceCriteria[0]!,
    0,
  );

  // Calls 2..N: parallel. Each reads the cache built by call 1.
  // Promise.all dispatches them concurrently; per-call retries (on
  // invalid output) happen independently and do NOT block each other.
  const restCalls = await Promise.all(
    input.acceptanceCriteria.slice(1).map((criterion, i) =>
      callOne(deps, model, cappedDiff, criterion, i + 1),
    ),
  );

  const allCalls = [call1, ...restCalls];

  // Aggregate.
  const perCriterion: PerCriterionJudgment[] = [];
  const verifierErrors: VerifierError[] = [];
  const usages: TokenUsage[] = [];
  const debugCalls: SemanticDebugCall[] = [];

  for (const c of allCalls) {
    usages.push(...c.usages);
    if (c.judgment) {
      perCriterion.push(c.judgment);
    }
    if (c.error) {
      verifierErrors.push({
        criterion: c.criterion,
        reason: c.error.reason,
        message: c.error.message,
      });
    }
    // Debug payload: one entry per criterion, capturing the FINAL state.
    debugCalls.push({
      criterionIndex: c.criterionIndex,
      criterion: c.criterion,
      userPrompt: c.finalUserPrompt,
      rawToolInput: c.finalRawToolInput,
      validatorOutcome: c.judgment
        ? { ok: true }
        : {
            ok: false,
            reason: c.error?.reason === 'sdk_error' ? 'sdk_error' : 'invalid_output',
            errors: c.error ? [c.error.message] : ['(no detail captured)'],
          },
    });
  }

  // Refinement A: debug artifact written when ANY call (across any
  // criterion) failed validation — INCLUDING when a retry recovered.
  // This preserves the cross-call diagnostic surface we want for
  // post-mortems. SDK-error-only criteria don't trigger debug
  // (there's no model output to compare against).
  const anyValidationFailure = allCalls.some((c) => c.hadValidationFailure);

  // Whole-task SDK-error skip: every call ended in SDK error AND
  // onSdkError is 'skip'. The composer (runVerifier) accepts the
  // exit-code verdict alone.
  const allSdkErrors =
    verifierErrors.length === allCalls.length &&
    verifierErrors.every((e) => e.reason === 'sdk_error');
  if (allSdkErrors && onSdkError === 'skip') {
    deps.logger?.warn(
      'semantic-verifier: all calls SDK-errored, skipping per onSdkError=skip',
      { errors: verifierErrors.length },
    );
    return {
      ok: false,
      reason: 'skipped',
      message: `all ${allCalls.length} per-criterion calls SDK-errored: ${verifierErrors[0]?.message}`,
      usages,
    };
  }

  const matches = perCriterion.length === allCalls.length && perCriterion.every((c) => c.met);

  const result: Extract<SemanticVerifierResult, { ok: true }> = {
    ok: true,
    matches,
    perCriterion,
    verifierErrors,
    usages,
    diffTruncated: truncated,
  };
  if (anyValidationFailure) {
    result.debug = {
      systemPrompt: SEMANTIC_SYSTEM_PROMPT,
      calls: debugCalls,
    };
  }
  return result;
}

// --- internals ------------------------------------------------------------

type PerCallResult = {
  criterionIndex: number;
  criterion: string;
  finalUserPrompt: string;
  finalRawToolInput: unknown;
  judgment?: PerCriterionJudgment;
  error?: { reason: 'sdk_error' | 'invalid_output'; message: string };
  usages: TokenUsage[];
  /**
   * True if any SDK call for this criterion returned a tool_use that
   * failed validation — regardless of whether a subsequent retry
   * recovered. Refinement A: this triggers the debug artifact for the
   * whole task, capturing ALL criteria's final state.
   */
  hadValidationFailure: boolean;
};

/**
 * Run one criterion through the verifier with up to 1 retry on invalid
 * output. Independent per-call retry: criterion N's retry does not
 * block criterion M's primary call.
 */
async function callOne(
  deps: SemanticVerifierDeps,
  model: string,
  diff: string,
  criterion: string,
  criterionIndex: number,
): Promise<PerCallResult> {
  const usages: TokenUsage[] = [];

  const prompt1 = buildSemanticUserPrompt(diff, criterion);
  const call1 = await sdkCall(deps, model, prompt1);
  if ('error' in call1) {
    return {
      criterionIndex,
      criterion,
      finalUserPrompt: prompt1.cachedPrefix + prompt1.criterionSuffix,
      finalRawToolInput: null,
      error: { reason: 'sdk_error', message: call1.error },
      usages,
      hadValidationFailure: false,
    };
  }
  usages.push(call1.usage);

  const validated1 = validateSingleJudgment(call1.toolInput, criterion);
  if ('judgment' in validated1) {
    return {
      criterionIndex,
      criterion,
      finalUserPrompt: prompt1.cachedPrefix + prompt1.criterionSuffix,
      finalRawToolInput: call1.toolInput,
      judgment: validated1.judgment,
      usages,
      hadValidationFailure: false,
    };
  }

  // Call 1 failed validation. Retry. The hadValidationFailure flag is
  // now true regardless of whether call 2 recovers — refinement A.
  deps.logger?.warn(
    'semantic-verifier: criterion call 1 invalid; retrying',
    { criterionIndex, errors: validated1.errors },
  );
  const prompt2 = buildSemanticRetryUserPrompt(diff, criterion, validated1.errors);
  const call2 = await sdkCall(deps, model, prompt2);
  if ('error' in call2) {
    return {
      criterionIndex,
      criterion,
      finalUserPrompt: prompt2.cachedPrefix + prompt2.criterionSuffix,
      finalRawToolInput: null,
      error: { reason: 'sdk_error', message: call2.error },
      usages,
      hadValidationFailure: true,
    };
  }
  usages.push(call2.usage);

  const validated2 = validateSingleJudgment(call2.toolInput, criterion);
  if ('judgment' in validated2) {
    return {
      criterionIndex,
      criterion,
      finalUserPrompt: prompt2.cachedPrefix + prompt2.criterionSuffix,
      finalRawToolInput: call2.toolInput,
      judgment: validated2.judgment,
      usages,
      hadValidationFailure: true,
    };
  }

  // Both calls invalid.
  return {
    criterionIndex,
    criterion,
    finalUserPrompt: prompt2.cachedPrefix + prompt2.criterionSuffix,
    finalRawToolInput: call2.toolInput,
    error: {
      reason: 'invalid_output',
      message: `criterion produced invalid output twice: ${validated2.errors.join('; ')}`,
    },
    usages,
    hadValidationFailure: true,
  };
}

type SdkSuccess = { toolInput: unknown; usage: TokenUsage };
type SdkFailure = { error: string };

async function sdkCall(
  deps: SemanticVerifierDeps,
  model: string,
  prompt: { cachedPrefix: string; criterionSuffix: string },
): Promise<SdkSuccess | SdkFailure> {
  try {
    const response = await deps.client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SEMANTIC_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            // The diff portion of the user prompt is constant across all
            // calls within a task. Marking it with cache_control lets
            // calls 2..N pay the cache-read rate ($0.30/MTok) on this
            // prefix instead of the full input rate ($3/MTok).
            {
              type: 'text',
              text: prompt.cachedPrefix,
              cache_control: { type: 'ephemeral' },
            },
            // The criterion text varies per call and lives AFTER the
            // cache breakpoint. It pays the full input rate but is
            // small (~30-150 tokens).
            {
              type: 'text',
              text: prompt.criterionSuffix,
            },
          ],
        },
      ],
      tools: [
        {
          name: SEMANTIC_TOOL_NAME,
          description:
            'Submit the judgment for a single acceptance criterion. Returns one object with criterion (verbatim), met (boolean), and reasoning (one-to-three sentences citing diff evidence). Do NOT return an array; do NOT wrap in another container; do NOT stringify.',
          input_schema:
            SEMANTIC_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: SEMANTIC_TOOL_NAME },
    });
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolUse) {
      return { error: 'response did not include a tool_use block' };
    }
    const usage = mapUsage(response.usage);
    return { toolInput: toolUse.input, usage };
  } catch (err) {
    return { error: String(err) };
  }
}

function mapUsage(raw: Anthropic.Usage): TokenUsage {
  const inputTokens = raw.input_tokens ?? 0;
  const outputTokens = raw.output_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheCreate = raw.cache_creation_input_tokens ?? 0;

  const usage: TokenUsage = { inputTokens, outputTokens };
  if (cacheRead > 0) usage.cacheReadInputTokens = cacheRead;
  if (cacheCreate > 0) usage.cacheCreationInputTokens = cacheCreate;
  usage.costUsd =
    (inputTokens / 1_000_000) * SONNET_PRICING.input +
    (outputTokens / 1_000_000) * SONNET_PRICING.output +
    (cacheRead / 1_000_000) * SONNET_PRICING.cacheRead +
    (cacheCreate / 1_000_000) * SONNET_PRICING.cacheCreate;
  return usage;
}

function capDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= DIFF_CAP_BYTES) {
    return { diff, truncated: false };
  }
  const head = diff.slice(0, DIFF_CAP_BYTES);
  return {
    diff: `${head}${TRUNCATION_MARKER}\n[truncated: ${diff.length - DIFF_CAP_BYTES} more bytes]`,
    truncated: true,
  };
}
