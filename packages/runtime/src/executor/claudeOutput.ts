/**
 * Parser for `claude --output-format json` stdout.
 *
 * The CLI emits a single JSON object (when invoked with `--print
 * --output-format json`) containing:
 *   - type: "result"
 *   - subtype: "success" | "error_during_execution" | ...
 *   - is_error: boolean
 *   - duration_ms: number               wall clock observed by the CLI
 *   - duration_api_ms: number           portion spent in Anthropic API
 *   - num_turns: number                 agent turns
 *   - result: string                    final assistant text
 *   - total_cost_usd: number            aggregate cost
 *   - usage: {                          aggregate token counts
 *       input_tokens, output_tokens,
 *       cache_read_input_tokens, cache_creation_input_tokens, ...
 *     }
 *
 * We treat the shape as fragile — claude is an external tool whose schema
 * can shift between releases. The parser:
 *   - Tolerates missing fields (returns undefined where the field is absent)
 *   - Never throws on a structurally-different payload; returns null instead
 *     and the caller logs a warn. We'd rather record zero tokens than crash
 *     the run on a schema mismatch.
 *
 * Snapshot of a known-good response lives at
 * `test/executor/fixtures/claude-output-sample.json` — the parser tests run
 * against it so future schema changes fail loudly with a useful diff.
 */

import type { TokenUsage } from '@agent-loop/core';

export interface ClaudeRunSummary {
  /** The assistant's final text response. */
  result: string;
  /** Wall-clock as observed by the CLI. */
  durationMs: number;
  /** Subset of duration_ms spent in API calls. */
  apiDurationMs?: number;
  /** Number of agent turns. */
  numTurns?: number;
  usage: TokenUsage;
  /** Raw subtype string from the CLI (e.g. "success", "error_during_execution"). */
  subtype: string;
  isError: boolean;
}

/**
 * Parse a `claude --output-format json` stdout payload. Returns null if the
 * input is not parseable JSON or doesn't have the expected `type: "result"`
 * shape. Never throws.
 */
export function parseClaudeJsonOutput(stdout: string): ClaudeRunSummary | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed['type'] !== 'result') return null;

  const usage = extractUsage(parsed);
  if (!usage) return null;

  // Build conditionally so we don't assign `undefined` to optional fields
  // (exactOptionalPropertyTypes treats those as distinct from "not present").
  const summary: ClaudeRunSummary = {
    result: typeof parsed['result'] === 'string' ? parsed['result'] : '',
    durationMs: numberOr(parsed['duration_ms'], 0),
    usage,
    subtype: typeof parsed['subtype'] === 'string' ? parsed['subtype'] : 'unknown',
    isError: parsed['is_error'] === true,
  };
  const apiDurationMs = numberOrUndefined(parsed['duration_api_ms']);
  if (apiDurationMs !== undefined) summary.apiDurationMs = apiDurationMs;
  const numTurns = numberOrUndefined(parsed['num_turns']);
  if (numTurns !== undefined) summary.numTurns = numTurns;
  return summary;
}

/**
 * Sum the token kinds in a TokenUsage for budget comparisons. All four are
 * billable (cache reads at a lower rate), so the sum is what we charge
 * against `Run.tokensSpent`.
 */
export function sumTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  );
}

// --- internals -------------------------------------------------------------

function extractUsage(parsed: Record<string, unknown>): TokenUsage | null {
  const raw = parsed['usage'];
  if (!isRecord(raw)) return null;

  const inputTokens = numberOrUndefined(raw['input_tokens']);
  const outputTokens = numberOrUndefined(raw['output_tokens']);
  // Both must exist — without them there's no real usage to record.
  if (inputTokens === undefined || outputTokens === undefined) return null;

  const usage: TokenUsage = { inputTokens, outputTokens };
  const cacheRead = numberOrUndefined(raw['cache_read_input_tokens']);
  if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
  const cacheCreation = numberOrUndefined(raw['cache_creation_input_tokens']);
  if (cacheCreation !== undefined) usage.cacheCreationInputTokens = cacheCreation;
  const cost = numberOrUndefined(parsed['total_cost_usd']);
  if (cost !== undefined) usage.costUsd = cost;

  return usage;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
