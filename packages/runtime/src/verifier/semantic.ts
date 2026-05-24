/**
 * runSemanticVerifier — internal step inside the verifier package.
 *
 * Given a diff + a list of acceptance criteria, calls Sonnet via forced
 * tool_use and returns a per-criterion judgment. Same shape as runTriage /
 * runPlanner but a different dependency story:
 *
 *   1. Path A for token usage: this function does NOT apply
 *      record_token_usage events. It returns `usages: TokenUsage[]` and
 *      the caller (tickVerifying, via runVerifier) applies them. The
 *      verifier stays a function of inputs + deps — no orchestrator
 *      coupling. The downside is that retry-storm budget is checked AFTER
 *      both calls land, but max retry count is 1 (so ≤2 calls per run,
 *      cost capped at ~$0.04) and the bound is tolerable.
 *
 *   2. SDK error policy is "strict by default": on a thrown SDK error,
 *      the function returns ok:false reason:'sdk_error'. The composer
 *      (runVerifier) decides how to fold that into the overall Verdict
 *      based on VerifyOptions.semanticOnSdkError. Default 'strict' →
 *      semanticCheck.matches: false. Opt-in 'skip' → semantic step is
 *      treated as not-run and the exit-code verdict stands alone.
 *
 *   3. The diff is capped at 30 KB. If the input diff is larger, we
 *      truncate to 30 KB and append a marker. The model is told it's
 *      truncated and may mark `met: false` for criteria it cannot
 *      evaluate. Better to defer than to guess.
 *
 *   4. Two consecutive invalid outputs → synthesized "invalid output
 *      twice" failure, same conservative pattern as triage/planner.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { type Logger, type TokenUsage } from '@agent-loop/core';
import type { AnthropicClient } from '../agents/sdkClient.js';
import { SONNET_PRICING } from '../agents/pricing.js';
import {
  SEMANTIC_INPUT_SCHEMA,
  SEMANTIC_TOOL_NAME,
  type PerCriterionJudgment,
  type SemanticDebug,
  type SemanticDebugCall,
} from './semanticSchema.js';
import {
  SEMANTIC_SYSTEM_PROMPT,
  buildSemanticRetryUserPrompt,
  buildSemanticUserPrompt,
} from './semanticPrompt.js';
import { validateSemanticOutput } from './semanticValidate.js';

export const DEFAULT_SEMANTIC_MODEL = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 4_000;
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
  /**
   * What to do when the SDK throws (network, rate limit, auth).
   * 'strict' (default): return ok:false reason:'sdk_error'. The composer
   *   marks the overall verdict as failed.
   * 'skip': return ok:false reason:'skipped'. The composer treats the
   *   semantic step as not-run; the exit-code verdict stands alone.
   */
  onSdkError?: SemanticOnSdkError;
}

export type SemanticVerifierResult =
  | {
      ok: true;
      matches: boolean;
      perCriterion: ReadonlyArray<PerCriterionJudgment>;
      usages: TokenUsage[];
      diffTruncated: boolean;
      /**
       * Present iff call 1 failed validation and call 2 succeeded.
       * Captures the raw output so we can see what shape call 1 produced
       * and confirm the retry-feedback fix worked. Absent on clean
       * happy-path (call 1 succeeded).
       */
      debug?: SemanticDebug;
    }
  | {
      ok: false;
      reason: 'sdk_error' | 'invalid_output' | 'skipped';
      message: string;
      usages: TokenUsage[];
      /**
       * Present iff reason === 'invalid_output' (both calls failed
       * validation). Absent on sdk_error and skipped — those have no
       * model output to capture.
       */
      debug?: SemanticDebug;
    };

export async function runSemanticVerifier(
  deps: SemanticVerifierDeps,
  input: SemanticVerifierInput,
  options: SemanticVerifierOptions = {},
): Promise<SemanticVerifierResult> {
  const model = deps.model ?? DEFAULT_SEMANTIC_MODEL;
  const onSdkError: SemanticOnSdkError = options.onSdkError ?? 'strict';

  const { diff: capped, truncated } = capDiff(input.diff);
  const userPrompt = buildSemanticUserPrompt(capped, input.acceptanceCriteria);

  deps.logger?.info('semantic-verifier: starting', {
    model,
    criteriaCount: input.acceptanceCriteria.length,
    diffBytes: capped.length,
    truncated,
  });

  const usages: TokenUsage[] = [];
  const debugCalls: SemanticDebugCall[] = [];

  const call1 = await callSemanticOnce(deps, model, userPrompt);
  if ('error' in call1) {
    deps.logger?.error('semantic-verifier: SDK error on call 1', {
      err: call1.error,
    });
    return sdkErrorResult(call1.error, onSdkError, usages, deps.logger);
  }
  usages.push(call1.usage);

  const validated1 = validateSemanticOutput(
    call1.toolInput,
    input.acceptanceCriteria,
  );
  if ('payload' in validated1) {
    // Happy path: call 1 valid, no retry, no debug artifact.
    return shapeOk(validated1.payload.perCriterion, usages, truncated);
  }

  // Call 1 failed validation. Capture the raw output for the debug artifact;
  // we'll surface it whether or not call 2 succeeds.
  debugCalls.push({
    userPrompt,
    rawToolInput: call1.toolInput,
    validatorErrors: [...validated1.errors],
  });

  deps.logger?.warn('semantic-verifier: call 1 invalid; retrying with feedback', {
    errors: validated1.errors,
  });
  const retryPrompt = buildSemanticRetryUserPrompt(
    userPrompt,
    validated1.errors,
    input.acceptanceCriteria.length,
  );
  const call2 = await callSemanticOnce(deps, model, retryPrompt);
  if ('error' in call2) {
    deps.logger?.error('semantic-verifier: SDK error on call 2', {
      err: call2.error,
    });
    // SDK error on call 2 — we have debug data from call 1 but no call 2
    // output to capture. The sdk_error path doesn't carry debug (per the
    // type), but the call 1 raw output is still in the logger context
    // for now. (Persisting debug across SDK errors is a future polish if
    // we find ourselves needing it.)
    return sdkErrorResult(call2.error, onSdkError, usages, deps.logger);
  }
  usages.push(call2.usage);

  const validated2 = validateSemanticOutput(
    call2.toolInput,
    input.acceptanceCriteria,
  );
  if ('payload' in validated2) {
    // Call 2 succeeded after call 1 failed: capture call 2 (no errors)
    // and return ok with the debug artifact attached so we can see what
    // shape the retry produced.
    debugCalls.push({
      userPrompt: retryPrompt,
      rawToolInput: call2.toolInput,
    });
    const result = shapeOk(validated2.payload.perCriterion, usages, truncated);
    if (result.ok) {
      return {
        ...result,
        debug: {
          systemPrompt: SEMANTIC_SYSTEM_PROMPT,
          calls: debugCalls,
          finalOutcome: 'ok',
        },
      };
    }
    return result;
  }

  // Both calls failed validation.
  debugCalls.push({
    userPrompt: retryPrompt,
    rawToolInput: call2.toolInput,
    validatorErrors: [...validated2.errors],
  });
  deps.logger?.error('semantic-verifier: call 2 also invalid; giving up', {
    errors: validated2.errors,
  });
  return {
    ok: false,
    reason: 'invalid_output',
    message: `semantic verifier produced invalid output twice: ${validated2.errors.join('; ')}`,
    usages,
    debug: {
      systemPrompt: SEMANTIC_SYSTEM_PROMPT,
      calls: debugCalls,
      finalOutcome: 'invalid_output',
    },
  };
}

// --- internals ------------------------------------------------------------

type CallSuccess = { toolInput: unknown; usage: TokenUsage };
type CallFailure = { error: string };

async function callSemanticOnce(
  deps: SemanticVerifierDeps,
  model: string,
  userPrompt: string,
): Promise<CallSuccess | CallFailure> {
  try {
    const response = await deps.client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SEMANTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          name: SEMANTIC_TOOL_NAME,
          description:
            'Submit per-criterion judgments for the diff. Each acceptance criterion gets exactly one entry with met:true|false and a one-to-three-sentence reasoning citing diff evidence.',
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

function shapeOk(
  perCriterion: ReadonlyArray<PerCriterionJudgment>,
  usages: TokenUsage[],
  diffTruncated: boolean,
): SemanticVerifierResult {
  const matches = perCriterion.every((c) => c.met);
  return { ok: true, matches, perCriterion, usages, diffTruncated };
}

function sdkErrorResult(
  message: string,
  onSdkError: SemanticOnSdkError,
  usages: TokenUsage[],
  logger?: Logger,
): SemanticVerifierResult {
  if (onSdkError === 'skip') {
    logger?.warn('semantic-verifier: SDK error, skipping per onSdkError=skip', {
      message,
    });
    return { ok: false, reason: 'skipped', message, usages };
  }
  return { ok: false, reason: 'sdk_error', message, usages };
}
