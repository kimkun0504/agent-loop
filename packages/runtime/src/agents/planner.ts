/**
 * runPlanner — the planner agent. Same shape as runTriage but with:
 *   - Sonnet 4.6 (heavier model)
 *   - Spec + file-content context (collectRepoContext + collectFileContents)
 *   - input/output schema for a Plan, not a Spec
 *
 * Per Week 3 plan §F3 (carried over from triage): the agent applies
 * record_token_usage for each SDK call (call 1's usage applied BEFORE
 * the retry, so budget enforcement sees the full retry-storm cost).
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  type Logger,
  type RunId,
  type Spec,
  type TokenUsage,
} from '@agent-loop/core';
import type { Store } from '../db/store.js';
import { applyEvent } from '../orchestrator/apply.js';
import type { AnthropicClient } from './sdkClient.js';
import {
  collectFileContents,
  collectRepoContext,
} from './repoContext.js';
import {
  PLANNER_INPUT_SCHEMA,
  PLANNER_TOOL_NAME,
  type PlannerResult,
} from './plannerSchema.js';
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerRetryUserPrompt,
  buildPlannerUserPrompt,
} from './plannerPrompt.js';
import { validatePlannerOutput } from './plannerValidate.js';

/**
 * Approximate Sonnet 4.6 per-MTok pricing. Sonnet is ~3x Haiku's price for
 * input and output, ~3x for cache reads. As with triage, getting cost
 * within 10% is good enough — the audit trail value is in being able to
 * compare runs across phases.
 */
const SONNET_PRICING = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.30,
  cacheCreate: 3.75,
} as const;

export const DEFAULT_PLANNER_MODEL = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 4_000;

export interface PlannerDeps {
  client: AnthropicClient;
  store: Store;
  runId: RunId;
  now: () => string;
  logger?: Logger;
  model?: string;
}

export interface PlannerInput {
  spec: Spec;
  targetRepoPath: string;
}

export async function runPlanner(
  deps: PlannerDeps,
  input: PlannerInput,
): Promise<PlannerResult> {
  const model = deps.model ?? DEFAULT_PLANNER_MODEL;
  const repo = collectRepoContext(input.targetRepoPath);
  const files = collectFileContents(
    input.targetRepoPath,
    input.spec.fileScope,
  );
  const userPrompt = buildPlannerUserPrompt(input.spec, repo, files);

  deps.logger?.info('planner: starting', {
    runId: deps.runId,
    model,
    repoBytes: repo.totalBytes,
    files: files.length,
    fileBytes: files.reduce((s, f) => s + f.content.length, 0),
  });

  const usages: TokenUsage[] = [];

  const call1 = await callPlannerOnce(deps, model, userPrompt);
  if ('error' in call1) {
    deps.logger?.error('planner: SDK error on call 1', {
      runId: deps.runId,
      err: call1.error,
    });
    return { ok: false, reason: 'sdk_error', message: call1.error, usages };
  }
  recordUsage(deps, call1.usage, usages);

  const validated1 = validatePlannerOutput(call1.toolInput);
  if (!('errors' in validated1)) {
    return shapeResult(deps, validated1, usages);
  }

  deps.logger?.warn('planner: call 1 invalid; retrying with feedback', {
    runId: deps.runId,
    errors: validated1.errors,
  });
  const retryPrompt = buildPlannerRetryUserPrompt(userPrompt, validated1.errors);
  const call2 = await callPlannerOnce(deps, model, retryPrompt);
  if ('error' in call2) {
    deps.logger?.error('planner: SDK error on call 2', {
      runId: deps.runId,
      err: call2.error,
    });
    return { ok: false, reason: 'sdk_error', message: call2.error, usages };
  }
  recordUsage(deps, call2.usage, usages);

  const validated2 = validatePlannerOutput(call2.toolInput);
  if (!('errors' in validated2)) {
    return shapeResult(deps, validated2, usages);
  }

  deps.logger?.error('planner: call 2 also invalid; giving up', {
    runId: deps.runId,
    errors: validated2.errors,
  });
  return {
    ok: false,
    reason: 'invalid_output',
    message: `planner produced invalid output twice: ${validated2.errors.join('; ')}`,
    usages,
  };
}

// --- internals ------------------------------------------------------------

type CallSuccess = { toolInput: unknown; usage: TokenUsage };
type CallFailure = { error: string };

async function callPlannerOnce(
  deps: PlannerDeps,
  model: string,
  userPrompt: string,
): Promise<CallSuccess | CallFailure> {
  try {
    const response = await deps.client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: PLANNER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          name: PLANNER_TOOL_NAME,
          description:
            'Submit the plan for this spec — either a Plan with files/approach/risks/testStrategy, or a rejection if the spec is unimplementable as written.',
          input_schema: PLANNER_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: PLANNER_TOOL_NAME },
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

function recordUsage(
  deps: PlannerDeps,
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
  deps: PlannerDeps,
  validated: Exclude<
    ReturnType<typeof validatePlannerOutput>,
    { errors: string[] }
  >,
  usages: TokenUsage[],
): PlannerResult {
  if (validated.kind === 'plan') {
    deps.logger?.info('planner: produced plan', {
      runId: deps.runId,
      files: validated.plan.filesToTouch.length,
      risks: validated.plan.risks.length,
    });
    return { ok: true, plan: validated.plan, usages };
  }
  deps.logger?.warn('planner: rejected', {
    runId: deps.runId,
    reason: validated.reason,
    message: validated.message,
  });
  return {
    ok: false,
    reason: validated.reason,
    message: validated.message,
    usages,
  };
}
