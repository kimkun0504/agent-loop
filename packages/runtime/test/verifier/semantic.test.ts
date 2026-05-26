/**
 * Tests for runSemanticVerifier with per-criterion architecture.
 *
 * The model gets ONE call per criterion; the aggregator builds
 * perCriterion[] + verifierErrors[]. Failure isolation: a failed call
 * marks just that criterion; other criteria still get judgments.
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

/**
 * Build a per-call client that dispatches based on call ORDER.
 * Each call returns the next canned response in `responses`. An Error
 * value in the array causes that call to throw.
 *
 * Captures every request for later assertion (cache_control, etc.).
 */
function fakeClient(responses: Array<unknown>): {
  client: AnthropicClient;
  requests: Array<{ messages: unknown; system: unknown }>;
} {
  let i = 0;
  const requests: Array<{ messages: unknown; system: unknown }> = [];
  const client = {
    messages: {
      create: async (req: { messages: unknown; system: unknown }) => {
        requests.push({ messages: req.messages, system: req.system });
        const r = responses[i++];
        if (r === undefined) {
          throw new Error('fakeClient: no more canned responses');
        }
        if (r instanceof Error) throw r;
        return r;
      },
    },
  } as unknown as AnthropicClient;
  return { client, requests };
}

function toolUseResponse(toolInput: unknown, usage = {
  input_tokens: 1000,
  output_tokens: 80,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}): unknown {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      {
        type: 'tool_use',
        id: 'toolu',
        name: 'submit_verdict',
        input: toolInput,
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

const criteria = ['foo is bar', 'baz is qux'];

const judgment = (criterion: string, met: boolean, reasoning = 'r'): unknown => ({
  criterion,
  met,
  reasoning,
});

describe('runSemanticVerifier: aggregation', () => {
  it('aggregates N successful judgments into perCriterion[]; matches=true when all met', async () => {
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      toolUseResponse(judgment('baz is qux', true)),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(true);
      expect(r.perCriterion).toHaveLength(2);
      expect(r.verifierErrors).toHaveLength(0);
      expect(r.usages).toHaveLength(2);
      expect(r.debug).toBeUndefined();
    }
  });

  it('matches=false when at least one met:false', async () => {
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      toolUseResponse(judgment('baz is qux', false, 'not met')),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(false);
      expect(r.perCriterion[1]?.met).toBe(false);
      expect(r.debug).toBeUndefined();
    }
  });

  it('isolates failures: criterion 2 fails twice but criterion 1 still gets a judgment', async () => {
    const invalid = { wrong: 'shape' };
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),  // criterion 1 call 1: OK
      toolUseResponse(invalid),                       // criterion 2 call 1: invalid
      toolUseResponse(invalid),                       // criterion 2 call 2 (retry): invalid
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(false);
      expect(r.perCriterion).toHaveLength(1);
      expect(r.perCriterion[0]?.criterion).toBe('foo is bar');
      expect(r.verifierErrors).toHaveLength(1);
      expect(r.verifierErrors[0]?.criterion).toBe('baz is qux');
      expect(r.verifierErrors[0]?.reason).toBe('invalid_output');
    }
  });

  it('isolates SDK errors: criterion 2 SDK-errors but criterion 1 succeeds', async () => {
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),  // criterion 1: OK
      new Error('rate_limit'),                         // criterion 2: SDK error
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(false);
      expect(r.perCriterion).toHaveLength(1);
      expect(r.verifierErrors[0]?.reason).toBe('sdk_error');
      expect(r.verifierErrors[0]?.message).toMatch(/rate_limit/);
    }
  });
});

describe('runSemanticVerifier: per-criterion retry', () => {
  it('criterion call 1 invalid + criterion call 2 valid: criterion succeeds', async () => {
    const invalid = { wrong: 'shape' };
    const { client } = fakeClient([
      toolUseResponse(invalid),                       // criterion 1 call 1: invalid
      toolUseResponse(judgment('foo is bar', true)),  // criterion 1 call 2: OK
      toolUseResponse(judgment('baz is qux', true)),  // criterion 2: OK
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(true);
      expect(r.perCriterion).toHaveLength(2);
      expect(r.verifierErrors).toHaveLength(0);
      // 3 SDK calls total (criterion 1 retried).
      expect(r.usages).toHaveLength(3);
      // Debug artifact present because there was at least one validation failure.
      expect(r.debug).toBeDefined();
      expect(r.debug?.calls).toHaveLength(2);
    }
  });
});

describe('runSemanticVerifier: SDK error policy', () => {
  it('default strict: per-criterion SDK error becomes verifierError, run continues', async () => {
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      new Error('network'),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);  // not the whole-task skip
    if (r.ok) {
      expect(r.matches).toBe(false);
      expect(r.verifierErrors).toHaveLength(1);
    }
  });

  it('skip mode + ALL calls SDK-error → ok:false reason:skipped (whole-task skip)', async () => {
    const { client } = fakeClient([
      new Error('rate_limit'),
      new Error('rate_limit'),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
      { onSdkError: 'skip' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('skipped');
      expect(r.message).toMatch(/all 2 per-criterion calls SDK-errored/);
    }
  });

  it('skip mode + SOME calls SDK-error → ok:true with per-criterion verifierErrors (not a skip)', async () => {
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      new Error('network'),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
      { onSdkError: 'skip' },
    );
    // Only the whole-task case is skipped; partial SDK error stays as verifierError.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verifierErrors).toHaveLength(1);
      expect(r.verifierErrors[0]?.reason).toBe('sdk_error');
    }
  });
});

describe('runSemanticVerifier: debug artifact (refinement A)', () => {
  it('writes debug with ALL calls when ANY call fails validation', async () => {
    const invalid = { wrong: 'shape' };
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),  // crit 1: OK
      toolUseResponse(invalid),                       // crit 2 call 1: invalid
      toolUseResponse(invalid),                       // crit 2 call 2: invalid
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'demo', acceptanceCriteria: criteria },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.debug).toBeDefined();
      expect(r.debug?.calls).toHaveLength(2);
      // Successful call has validatorOutcome.ok=true.
      const okCall = r.debug?.calls.find((c) => c.criterion === 'foo is bar');
      expect(okCall?.validatorOutcome.ok).toBe(true);
      // Failed call has validatorOutcome.ok=false with errors.
      const failedCall = r.debug?.calls.find((c) => c.criterion === 'baz is qux');
      expect(failedCall?.validatorOutcome.ok).toBe(false);
      if (failedCall && !failedCall.validatorOutcome.ok) {
        expect(failedCall.validatorOutcome.reason).toBe('invalid_output');
      }
    }
  });

  it('no debug written when all calls succeed', async () => {
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      toolUseResponse(judgment('baz is qux', true)),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    if (r.ok) {
      expect(r.debug).toBeUndefined();
    }
  });

  it('debug.systemPrompt captures the actual SEMANTIC_SYSTEM_PROMPT', async () => {
    const { client } = fakeClient([
      toolUseResponse({ wrong: 'shape' }),
      toolUseResponse({ wrong: 'shape' }),
      toolUseResponse(judgment('baz is qux', true)),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: criteria },
    );
    if (r.ok) {
      expect(r.debug?.systemPrompt).toContain('You verify whether');
    }
  });
});

describe('runSemanticVerifier: cache_control placement (test 14)', () => {
  it('cache_control is on the diff content block, not on the criterion content block', async () => {
    const { client, requests } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      toolUseResponse(judgment('baz is qux', true)),
    ]);
    await runSemanticVerifier(
      { client },
      { diff: 'demo diff', acceptanceCriteria: criteria },
    );
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      const blocks = (req.messages as Array<{ content: Array<{
        text?: string;
        cache_control?: unknown;
      }> }>)[0]?.content;
      expect(blocks).toBeDefined();
      expect(blocks).toHaveLength(2);
      // First block: the cached prefix (system continues + diff).
      const cachedBlock = blocks?.[0];
      expect(cachedBlock?.cache_control).toEqual({ type: 'ephemeral' });
      expect(cachedBlock?.text).toContain('# Diff');
      // Second block: the criterion. No cache_control.
      const criterionBlock = blocks?.[1];
      expect(criterionBlock?.cache_control).toBeUndefined();
      expect(criterionBlock?.text).toContain('# Acceptance criterion');
    }
  });
});

describe('runSemanticVerifier: diff cap', () => {
  it('does not truncate a diff at or under 30KB', async () => {
    const exactly30k = 'a'.repeat(30_000);
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      toolUseResponse(judgment('baz is qux', true)),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: exactly30k, acceptanceCriteria: criteria },
    );
    if (r.ok) expect(r.diffTruncated).toBe(false);
  });

  it('truncates a diff over 30KB and marks diffTruncated', async () => {
    const big = 'a'.repeat(40_000);
    const { client } = fakeClient([
      toolUseResponse(judgment('foo is bar', true)),
      toolUseResponse(judgment('baz is qux', true)),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: big, acceptanceCriteria: criteria },
    );
    if (r.ok) expect(r.diffTruncated).toBe(true);
  });
});

describe('runSemanticVerifier: edge cases', () => {
  it('handles N=1 (single criterion, no parallel section)', async () => {
    const { client } = fakeClient([
      toolUseResponse(judgment('only one', true)),
    ]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: ['only one'] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(true);
      expect(r.perCriterion).toHaveLength(1);
    }
  });

  it('handles N=0 (no criteria) — defensive', async () => {
    const { client } = fakeClient([]);
    const r = await runSemanticVerifier(
      { client },
      { diff: 'd', acceptanceCriteria: [] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches).toBe(true);
      expect(r.perCriterion).toHaveLength(0);
    }
  });
});

describe('runSemanticVerifier: logging', () => {
  it('logs starting + retry warning on invalid call 1 for a criterion', async () => {
    const lines: LoggedLine[] = [];
    const logger = fakeLogger(lines);
    const { client } = fakeClient([
      toolUseResponse({ wrong: 'shape' }),               // crit 1 call 1: invalid
      toolUseResponse(judgment('foo is bar', true)),     // crit 1 call 2: OK
      toolUseResponse(judgment('baz is qux', true)),     // crit 2: OK
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
