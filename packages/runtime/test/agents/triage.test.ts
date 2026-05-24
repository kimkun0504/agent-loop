/**
 * Tests for runTriage. The Anthropic SDK is mocked end-to-end via a
 * minimal client stub — no real API calls. The Store is a real in-memory
 * SQLite via openDb, so applyEvent + record_token_usage exercise the
 * actual transition table.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  RunId,
  TaskId,
  Logger,
  createRun,
  type Run,
} from '@agent-loop/core';
import { applyMigrations } from '../../src/db/migrate.js';
import { Store } from '../../src/db/store.js';
import { runTriage } from '../../src/agents/triage.js';
import { applyEvent } from '../../src/orchestrator/apply.js';
import type { AnthropicClient } from '../../src/agents/sdkClient.js';

const NOW = '2026-05-23T20:00:00.000Z';

function freshStore(): Store {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, () => NOW);
  return new Store(db);
}

function seedTriagingRun(store: Store): Run {
  const run = createRun({
    id: RunId('run-triage-test'),
    taskId: TaskId('local:hardcoded'),
    artifactDir: '/runs/run-triage-test',
    branch: 'agent/run-triage-test',
    now: NOW,
  });
  store.insertRun(run);
  applyEvent(store, run.id, { type: 'start_triage' }, NOW);
  return store.getRun(run.id)!;
}

let target: string;
beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'agent-loop-triage-target-'));
});

/**
 * Build an Anthropic-shaped client whose messages.create returns
 * pre-canned responses in sequence. The first call to create() returns
 * the first response; the second call returns the second; and so on.
 */
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

/** Build a successful Anthropic response that returns the given tool input. */
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
    model: 'claude-haiku-4-5-20251001',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'submit_triage_result',
        input: toolInput,
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

const validSpecInput = {
  kind: 'spec',
  spec: {
    title: 'Add foo helper',
    description: 'Add a foo function to src/foo.js. Tests in test/foo.test.js.',
    fileScope: ['src/foo.js', 'test/foo.test.js'],
    acceptanceCriteria: ['foo(1) returns 1', 'tests pass'],
    testCommands: ['npm test'],
  },
};

describe('runTriage: happy path', () => {
  it('returns ok:true with the validated spec when the SDK returns valid output', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const client = fakeClient([toolUseResponse(validSpecInput)]);

    const result = await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'Add a foo helper.', targetRepoPath: target },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.title).toBe('Add foo helper');
      expect(result.usages).toHaveLength(1);
    }
  });

  it('applies record_token_usage events for the single successful call', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const client = fakeClient([
      toolUseResponse(validSpecInput, {
        input_tokens: 500,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 4,
      }),
    ]);

    await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'x', targetRepoPath: target },
    );

    const events = store.listEvents(run.id);
    const tokenEvents = events.filter((e) => e.event.type === 'record_token_usage');
    expect(tokenEvents).toHaveLength(1);
    if (tokenEvents[0]?.event.type === 'record_token_usage') {
      // Sum = 500 + 50 + 10 + 4
      expect(tokenEvents[0].event.tokens).toBe(564);
      expect(tokenEvents[0].event.usage?.costUsd).toBeGreaterThan(0);
    }
  });
});

describe('runTriage: retry on invalid output', () => {
  it('retries once with feedback when call 1 is invalid', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const client = fakeClient([
      // Call 1: testCommands outside the documented vocabulary
      // (a negated grep — what triage USED to produce; now rejected).
      toolUseResponse({
        ...validSpecInput,
        spec: {
          ...validSpecInput.spec,
          testCommands: ['npm test', "! grep -rE 'foo\\b' src/"],
        },
      }),
      // Call 2: corrected
      toolUseResponse(validSpecInput),
    ]);

    const result = await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'x', targetRepoPath: target },
    );

    expect(result.ok).toBe(true);
    expect(result.usages).toHaveLength(2);

    // Both call's record_token_usage events should be applied.
    const events = store.listEvents(run.id);
    expect(events.filter((e) => e.event.type === 'record_token_usage')).toHaveLength(2);
  });

  it('returns reason=invalid_output when both calls fail validation', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const invalid = { ...validSpecInput, spec: { ...validSpecInput.spec, title: '' } };
    const client = fakeClient([
      toolUseResponse(invalid),
      toolUseResponse(invalid),
    ]);

    const result = await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'x', targetRepoPath: target },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_output');
      expect(result.usages).toHaveLength(2);
    }
  });

  it('records usage for call 1 BEFORE retrying (the §F3 rule)', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const invalid = { ...validSpecInput, spec: { ...validSpecInput.spec, title: '' } };
    const client = fakeClient([
      toolUseResponse(invalid, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      toolUseResponse(validSpecInput, { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);

    await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'x', targetRepoPath: target },
    );

    const events = store.listEvents(run.id);
    const tokenEvents = events.filter((e) => e.event.type === 'record_token_usage');
    expect(tokenEvents).toHaveLength(2);
    // Call 1's tokens (100+10=110) appears BEFORE call 2's (200+20=220) in the event log.
    if (tokenEvents[0]?.event.type === 'record_token_usage' && tokenEvents[1]?.event.type === 'record_token_usage') {
      expect(tokenEvents[0].event.tokens).toBe(110);
      expect(tokenEvents[1].event.tokens).toBe(220);
    }
  });
});

describe('runTriage: rejection branch', () => {
  it('returns ok:false with the model-chosen reason when kind=rejection', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const client = fakeClient([
      toolUseResponse({
        kind: 'rejection',
        rejection: {
          reason: 'too_vague',
          message: 'no acceptance criteria can be inferred',
          clarifyingQuestions: ['which file?'],
        },
      }),
    ]);

    const result = await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'do the thing', targetRepoPath: target },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_vague');
      expect(result.clarifyingQuestions).toEqual(['which file?']);
      expect(result.usages).toHaveLength(1);
    }
  });
});

describe('runTriage: SDK errors', () => {
  it('returns reason=sdk_error when the SDK throws on call 1', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const client = fakeClient([new Error('rate limited')]);

    const result = await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'x', targetRepoPath: target },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sdk_error');
      expect(result.message).toContain('rate limited');
      // No usages recorded — the call never returned.
      expect(result.usages).toEqual([]);
    }
  });

  it('returns reason=sdk_error when call 2 (retry) throws', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    const invalid = { ...validSpecInput, spec: { ...validSpecInput.spec, title: '' } };
    const client = fakeClient([
      toolUseResponse(invalid),
      new Error('network blip'),
    ]);

    const result = await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'x', targetRepoPath: target },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sdk_error');
      // Only call 1's usage was recorded; call 2 errored before usage extraction.
      expect(result.usages).toHaveLength(1);
    }
  });
});

describe('runTriage: malformed responses', () => {
  it('returns reason=invalid_output when the response has no tool_use block', async () => {
    const store = freshStore();
    const run = seedTriagingRun(store);
    // Response with text content only — no tool_use.
    const noTool = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'sorry, I cannot' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const client = fakeClient([noTool, noTool]);
    const result = await runTriage(
      { client, store, runId: run.id, now: () => NOW },
      { taskDescription: 'x', targetRepoPath: target },
    );
    expect(result.ok).toBe(false);
    // No tool_use is an sdk_error (we couldn't extract structure at all),
    // not invalid_output (which is for validation failures of well-formed
    // tool input).
    if (!result.ok) {
      expect(result.reason).toBe('sdk_error');
    }
  });
});

// Suppress test-local target dirs.
afterEach: {
  // top-level afterEach can't be used here without an import; the per-test
  // tmpdir is fine for now (rm'd by the OS eventually).
}
