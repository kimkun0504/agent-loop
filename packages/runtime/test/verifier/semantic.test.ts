/**
 * Tests for runSemanticVerifier. The Anthropic SDK is mocked end-to-end
 * via a minimal client stub — no real API calls.
 */

import { describe, expect, it } from 'vitest';
import type { Logger } from '@agent-loop/core';
import { runSemanticVerifier } from '../../src/verifier/semantic.js';
import type { AnthropicClient } from '../../src/agents/sdkClient.js';

type LoggedLine = { level: string; msg: string; ctx: Record<string, unknown> };

function fakeLogger(out: LoggedLine[]): Logger {
  const record = (level: string) => (msg: string, ctx?: Record<string, unknown>): void => {
    out.push({ level, msg, ctx: ctx ?? {} });
  };
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    child: () => fakeLogger(out),
  } as unknown as Logger;
}

function fakeClient(responses: Array<unknown>): AnthropicClient {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const r = responses[i++];
        if (r === undefined) {
          throw new Error('fakeClient: no more canned responses');
        }
        if (r instanceof Error) throw r;
        return r;
      },
    },
  } as unknown as AnthropicClient;
}

function toolUseResponse(toolInput: unknown, usage = {
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'submit_verdict',
        input: toolInput,
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

const criteria = ['foo is bar', 'baz is qux'];

const validAllMet = {
  perCriterion: [
    { criterion: 'foo is bar', met: true, reasoning: 'ev1' },
    { criterion: 'baz is qux', met: true, reasoning: 'ev2' },
  ],
};

const validMixed = {
  perCriterion: [
    { criterion: 'foo is bar', met: true, reasoning: 'ev1' },
    { criterion: 'baz is qux', met: false, reasoning: 'missing' },
  ],
};

describe('runSemanticVerifier: happy path', () => {
  it('returns ok:true matches:true when all judgments are met', async () => {
    const client = fakeClient([toolUseResponse(validAllMet)]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(true);
      expect(r.perCriterion).toHaveLength(2);
      expect(r.usages).toHaveLength(1);
      expect(r.diffTruncated).toBe(false);
    }
  });

  it('returns ok:true matches:false when at least one met=false', async () => {
    const client = fakeClient([toolUseResponse(validMixed)]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(false);
      expect(r.perCriterion[1]?.met).toBe(false);
    }
  });

  it('returns ok:true matches:false when every judgment is met=false', async () => {
    const allFail = {
      perCriterion: [
        { criterion: 'foo is bar', met: false, reasoning: 'no' },
        { criterion: 'baz is qux', met: false, reasoning: 'no' },
      ],
    };
    const client = fakeClient([toolUseResponse(allFail)]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matches).toBe(false);
  });

  it('computes costUsd from Sonnet pricing on the returned usage', async () => {
    const client = fakeClient([toolUseResponse(validAllMet)]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Sonnet: 1000 in × $3/M + 100 out × $15/M = 0.003 + 0.0015 = 0.0045
      expect(r.usages[0]?.costUsd).toBeCloseTo(0.0045, 5);
    }
  });
});

describe('runSemanticVerifier: retry on invalid output', () => {
  it('retries once and succeeds on call 2', async () => {
    const invalid = { perCriterion: [{ criterion: 'foo is bar', met: true }] };
    const client = fakeClient([
      toolUseResponse(invalid),
      toolUseResponse(validAllMet),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usages).toHaveLength(2);
      expect(r.matches).toBe(true);
    }
  });

  it('returns reason:invalid_output after two consecutive invalid calls', async () => {
    const invalid = { perCriterion: [] };
    const client = fakeClient([
      toolUseResponse(invalid),
      toolUseResponse(invalid),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('invalid_output');
      expect(r.usages).toHaveLength(2);
      expect(r.message).toMatch(/invalid output twice/);
    }
  });
});

describe('runSemanticVerifier: SDK error policy', () => {
  it('returns reason:sdk_error with default onSdkError=strict', async () => {
    const client = fakeClient([new Error('rate_limit')]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('sdk_error');
      expect(r.usages).toHaveLength(0);
      expect(r.message).toMatch(/rate_limit/);
    }
  });

  it('returns reason:skipped when onSdkError=skip', async () => {
    const client = fakeClient([new Error('network')]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
      { onSdkError: 'skip' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('skipped');
    }
  });

  it('strict mode applies on call 2 if call 1 invalid then call 2 throws', async () => {
    const client = fakeClient([
      toolUseResponse({ perCriterion: [] }),
      new Error('rate_limit'),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('sdk_error');
      expect(r.usages).toHaveLength(1); // only call 1 succeeded enough to record usage
    }
  });
});

describe('runSemanticVerifier: diff cap', () => {
  it('does not truncate a diff at or under 30KB', async () => {
    const client = fakeClient([toolUseResponse(validAllMet)]);
    const exactly30k = 'a'.repeat(30_000);
    const r = await runSemanticVerifier(
      { client },
      { diff: exactly30k, acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.diffTruncated).toBe(false);
  });

  it('truncates a diff over 30KB and marks diffTruncated', async () => {
    const client = fakeClient([toolUseResponse(validAllMet)]);
    const big = 'a'.repeat(40_000);
    const r = await runSemanticVerifier(
      { client },
      { diff: big, acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.diffTruncated).toBe(true);
  });

  it('handles empty diff', async () => {
    const client = fakeClient([toolUseResponse(validAllMet)]);
    const r = await runSemanticVerifier(
      { client },
      { diff: '', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
  });
});

describe('runSemanticVerifier: logging', () => {
  it('logs starting + retry warning on invalid call 1', async () => {
    const lines: LoggedLine[] = [];
    const logger = fakeLogger(lines);
    const client = fakeClient([
      toolUseResponse({ perCriterion: [] }),
      toolUseResponse(validAllMet),
    ]);
    await runSemanticVerifier(
      { client, logger },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(
      lines.some((l) => l.level === 'info' && l.msg === 'semantic-verifier: starting'),
    ).toBe(true);
    expect(
      lines.some((l) => l.level === 'warn' && l.msg.includes('call 1 invalid')),
    ).toBe(true);
  });
});
