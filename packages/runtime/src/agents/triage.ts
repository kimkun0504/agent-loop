/**
 * runTriage — the triage agent.
 *
 * Wraps one (sometimes two) Anthropic SDK calls. The model is forced to
 * call the `submit_triage_result` tool; we extract the tool_use input,
 * validate it semantically, and either return a Spec or a structured
 * rejection.
 *
 * Per Week 3 plan §F3, the agent applies `record_token_usage` events
 * itself — once for the first SDK call (even if its output was invalid)
 * and once for the retry. This makes budget enforcement see the FULL
 * cost of a retry storm rather than only the final successful call.
 * The caller (tickTriaging) does NOT apply usage events; it acts only
 * on the returned TriageResult.
 *
 * Retry policy: exactly one retry on invalid output, with the
 * validator's errors inlined into the prompt. Two consecutive
 * validation failures → return a TriageRejection with
 * reason: 'invalid_output'.
 *
 * Errors from the SDK (network, auth, rate-limit) surface as
 * reason: 'sdk_error' with the underlying message — also a structured
 * rejection, not a thrown exception, so the orchestrator can apply
 * triage_failed cleanly.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { type Logger, type RunId, type TokenUsage } from '@agent-loop/core';
import type { Store } from '../db/store.js';
import { applyEvent } from '../orchestrator/apply.js';
import type { AnthropicClient } from './sdkClient.js';
import { collectRepoContext } from './repoContext.js';
import {
  TRIAGE_INPUT_SCHEMA,
  TRIAGE_TOOL_NAME,
  type TriageResult,
} from './triageSchema.js';
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriageRetryUserPrompt,
  buildTriageUserPrompt,
} from './triagePrompt.js';
import { validateTriageOutput } from './triageValidate.js';

/**
 * Approximate per-MTok prices for the Haiku model triage uses. Hardcoded
 * for now; when planner ships in Phase E we'll grow this into a shared
 * price table keyed by model id. The dollar number is for the audit
 * trail / cost reports — getting it within 10% is good enough.
 */
const HAIKU_PRICING = {
  input: 1.0,
  output: 5.0,
  cacheRead: 0.10,
  cacheCreate: 1.25,
} as const;

export const DEFAULT_TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 2_000;

export interface TriageDeps {
  client: AnthropicClient;
  store: Store;
  runId: RunId;
  now: () => string;
  logger?: Logger;
  model?: string;
}

export interface TriageInput {
  taskDescription: string;
  taskTitle?: string;
  targetRepoPath: string;
}

export async function runTriage(
  deps: TriageDeps,
  input: TriageInput,
): Promise<TriageResult> {
  const model = deps.model ?? DEFAULT_TRIAGE_MODEL;
  const context = collectRepoContext(input.targetRepoPath);
  const userPrompt = buildTriageUserPrompt(
    input.taskDescription,
    context,
    input.taskTitle,
  );

  deps.logger?.info('triage: starting', {
    runId: deps.runId,
    model,
    contextBytes: context.totalBytes,
  });

  const usages: TokenUsage[] = [];

  // --- Call 1 -------------------------------------------------------------
  const call1 = await callTriageOnce(deps, model, userPrompt);
  if ('error' in call1) {
    deps.logger?.error('triage: SDK error on call 1', {
      runId: deps.runId,
      err: call1.error,
    });
    return { ok: false, reason: 'sdk_error', message: call1.error, usages };
  }
  recordUsage(deps, call1.usage, usages);

  const validated1 = validateTriageOutput(call1.toolInput);
  if (!('errors' in validated1)) {
    return shapeResult(deps, validated1, usages);
  }

  // --- Call 2 (retry) -----------------------------------------------------
  deps.logger?.warn('triage: call 1 invalid; retrying with feedback', {
    runId: deps.runId,
    errors: validated1.errors,
  });
  const retryPrompt = buildTriageRetryUserPrompt(userPrompt, validated1.errors);
  const call2 = await callTriageOnce(deps, model, retryPrompt);
  if ('error' in call2) {
    deps.logger?.error('triage: SDK error on call 2', {
      runId: deps.runId,
      err: call2.error,
    });
    return { ok: false, reason: 'sdk_error', message: call2.error, usages };
  }
  recordUsage(deps, call2.usage, usages);

  const validated2 = validateTriageOutput(call2.toolInput);
  if (!('errors' in validated2)) {
    return shapeResult(deps, validated2, usages);
  }

  deps.logger?.error('triage: call 2 also invalid; giving up', {
    runId: deps.runId,
    errors: validated2.errors,
  });
  return {
    ok: false,
    reason: 'invalid_output',
    message: `triage produced invalid output twice: ${validated2.errors.join('; ')}`,
    usages,
  };
}

// --- internals ------------------------------------------------------------

type CallSuccess = { toolInput: unknown; usage: TokenUsage };
type CallFailure = { error: string };

async function callTriageOnce(
  deps: TriageDeps,
  model: string,
  userPrompt: string,
): Promise<CallSuccess | CallFailure> {
  try {
    const response = await deps.client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: TRIAGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          name: TRIAGE_TOOL_NAME,
          description:
            'Submit the triage result for this task — either a spec the agent should implement, or a rejection explaining why no spec can be produced.',
          input_schema: TRIAGE_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: TRIAGE_TOOL_NAME },
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

  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
  };
  if (cacheRead > 0) usage.cacheReadInputTokens = cacheRead;
  if (cacheCreate > 0) usage.cacheCreationInputTokens = cacheCreate;

  const costUsd =
    (inputTokens / 1_000_000) * HAIKU_PRICING.input +
    (outputTokens / 1_000_000) * HAIKU_PRICING.output +
    (cacheRead / 1_000_000) * HAIKU_PRICING.cacheRead +
    (cacheCreate / 1_000_000) * HAIKU_PRICING.cacheCreate;
  usage.costUsd = costUsd;

  return usage;
}

function recordUsage(
  deps: TriageDeps,
  usage: TokenUsage,
  history: TokenUsage[],
): void {
  history.push(usage);
  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0);
  applyEvent(
    deps.store,
    deps.runId,
    { type: 'record_token_usage', tokens: totalTokens, usage },
    deps.now(),
  );
}

function shapeResult(
  deps: TriageDeps,
  validated: Exclude<
    ReturnType<typeof validateTriageOutput>,
    { errors: string[] }
  >,
  usages: TokenUsage[],
): TriageResult {
  if (validated.kind === 'spec') {
    deps.logger?.info('triage: produced spec', {
      runId: deps.runId,
      title: validated.spec.title,
      fileScope: validated.spec.fileScope,
    });
    return { ok: true, spec: validated.spec, usages };
  }
  deps.logger?.warn('triage: rejected', {
    runId: deps.runId,
    reason: validated.reason,
    message: validated.message,
  });
  const out: Extract<TriageResult, { ok: false }> = {
    ok: false,
    reason: validated.reason,
    message: validated.message,
    usages,
  };
  if (validated.clarifyingQuestions !== undefined) {
    out.clarifyingQuestions = validated.clarifyingQuestions;
  }
  return out;
}
