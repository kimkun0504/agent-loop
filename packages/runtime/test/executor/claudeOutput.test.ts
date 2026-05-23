/**
 * Fixture-driven tests for the claude --output-format json parser.
 *
 * The fixture at fixtures/claude-output-sample.json is a real captured
 * response from `claude --print --output-format json --permission-mode
 * bypassPermissions "Reply with exactly the word 'hello' and nothing else."`.
 *
 * Re-capture it when the CLI's output shape changes (the parser tests will
 * fail loudly first — that's the point). Capture command is documented at
 * the top of src/executor/claudeOutput.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseClaudeJsonOutput,
  sumTokens,
} from '../../src/executor/claudeOutput.js';

const FIXTURE_PATH = join(
  fileURLToPath(new URL('fixtures/claude-output-sample.json', import.meta.url)),
);
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

describe('parseClaudeJsonOutput against the captured fixture', () => {
  const parsed = parseClaudeJsonOutput(FIXTURE);

  it('returns a non-null summary', () => {
    expect(parsed).not.toBeNull();
  });

  it('extracts the assistant text', () => {
    expect(parsed?.result).toBe('hello');
  });

  it('extracts wall-clock duration in ms', () => {
    expect(parsed?.durationMs).toBe(2133);
  });

  it('extracts API duration when present', () => {
    expect(parsed?.apiDurationMs).toBe(2991);
  });

  it('extracts num_turns', () => {
    expect(parsed?.numTurns).toBe(1);
  });

  it('reports subtype and is_error', () => {
    expect(parsed?.subtype).toBe('success');
    expect(parsed?.isError).toBe(false);
  });

  it('maps usage.input_tokens / output_tokens', () => {
    expect(parsed?.usage.inputTokens).toBe(2024);
    expect(parsed?.usage.outputTokens).toBe(4);
  });

  it('maps cache_read_input_tokens and cache_creation_input_tokens', () => {
    expect(parsed?.usage.cacheReadInputTokens).toBe(10315);
    expect(parsed?.usage.cacheCreationInputTokens).toBe(2201);
  });

  it('captures total_cost_usd as TokenUsage.costUsd', () => {
    expect(parsed?.usage.costUsd).toBeCloseTo(0.02965275, 6);
  });
});

describe('parseClaudeJsonOutput: defensive returns (never throws)', () => {
  it('returns null on empty input', () => {
    expect(parseClaudeJsonOutput('')).toBeNull();
    expect(parseClaudeJsonOutput('   ')).toBeNull();
  });

  it('returns null on non-JSON input', () => {
    expect(parseClaudeJsonOutput('not json')).toBeNull();
    expect(parseClaudeJsonOutput('{ unterminated')).toBeNull();
  });

  it('returns null when type is not "result"', () => {
    const stream = JSON.stringify({
      type: 'assistant',
      message: { content: 'hi' },
    });
    expect(parseClaudeJsonOutput(stream)).toBeNull();
  });

  it('returns null when usage is missing entirely', () => {
    const noUsage = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'x',
    });
    expect(parseClaudeJsonOutput(noUsage)).toBeNull();
  });

  it('returns null when input/output token fields are absent', () => {
    const halfUsage = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { cache_read_input_tokens: 10 },
    });
    expect(parseClaudeJsonOutput(halfUsage)).toBeNull();
  });

  it('returns a summary when cache fields are absent but base fields present', () => {
    const minimal = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      result: 'ok',
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const parsed = parseClaudeJsonOutput(minimal);
    expect(parsed).not.toBeNull();
    expect(parsed?.usage.inputTokens).toBe(50);
    expect(parsed?.usage.outputTokens).toBe(10);
    expect(parsed?.usage.cacheReadInputTokens).toBeUndefined();
    expect(parsed?.usage.cacheCreationInputTokens).toBeUndefined();
    expect(parsed?.usage.costUsd).toBeUndefined();
  });

  it('treats numeric NaN / Infinity as missing', () => {
    const bad = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 'lots', output_tokens: 4 },
    });
    expect(parseClaudeJsonOutput(bad)).toBeNull();
  });
});

describe('sumTokens', () => {
  it('sums all four token kinds when present', () => {
    expect(
      sumTokens({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 4,
      }),
    ).toBe(1234);
  });

  it('treats missing cache fields as zero', () => {
    expect(sumTokens({ inputTokens: 100, outputTokens: 50 })).toBe(150);
  });

  it('sums the fixture to a sensible total', () => {
    const parsed = parseClaudeJsonOutput(FIXTURE);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    // 2024 + 4 + 10315 + 2201 = 14544
    expect(sumTokens(parsed.usage)).toBe(14544);
  });
});
