/**
 * runPlanner tests. SDK mocked (no real API calls). Store is real
 * in-memory SQLite. Same pattern as triage.test.ts.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
  createRun,
  type Run,
  type Spec,
} from '@agent-loop/core';
import { applyMigrations } from '../../src/db/migrate.js';
import { Store } from '../../src/db/store.js';
import { runPlanner } from '../../src/agents/planner.js';
import { applyEvent } from '../../src/orchestrator/apply.js';
import type { AnthropicClient } from '../../src/agents/sdkClient.js';

const NOW = '2026-05-24T00:00:00.000Z';

function freshStore(): Store {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, () => NOW);
  return new Store(db);
}

function seedPlanningRun(store: Store): Run {
  const run = createRun({
    id: RunId('run-planner-test'),
    taskId: TaskId('eval:test'),
    artifactDir: '/runs/test',
    branch: 'agent/test',
    now: NOW,
  });
  store.insertRun(run);
  // Drive to planning phase.
  applyEvent(store, run.id, { type: 'start_triage' }, NOW);
  applyEvent(
    store,
    run.id,
    { type: 'triage_succeeded', specId: SpecId('spec-planner-test') },
    NOW,
  );
  applyEvent(store, run.id, { type: 'spec_approved' }, NOW);
  return store.getRun(run.id)!;
}

function sampleSpec(): Spec {
  return {
    id: SpecId('spec-planner-test'),
    runId: RunId('run-planner-test'),
    title: 'Add foo',
    description: 'Add a foo function.',
    fileScope: ['src/foo.js', 'test/foo.test.js'],
    acceptanceCriteria: ['foo(1) returns 1'],
    testCommands: ['npm test'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  };
}

let target: string;
beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'agent-loop-planner-target-'));
});

function fakeClient(responses: Array<unknown>): AnthropicClient {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const r = responses[i++];
        if (r === undefined) throw new Error('fakeClient: no more canned responses');
        if (r instanceof Error) throw r;
        return r;
      },
    },
  } as unknown as AnthropicClient;
}

function toolUseResponse(input: unknown, usage = {
  input_tokens: 3000,
  output_tokens: 500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}): unknown {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      { type: 'tool_use', id: 't', name: 'submit_plan_result', input },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

const validPlanInput = {
  kind: 'plan',
  plan: {
    filesToTouch: [
      { path: 'src/foo.js', action: 'modify', reason: 'add export' },
      { path: 'test/foo.test.js', action: 'modify', reason: 'add tests' },
    ],
    approach: 'Add a foo() function to src/foo.js. Update tests.',
    risks: [],
    testStrategy: 'Run npm test.',
  },
};

describe('runPlanner: happy path', () => {
  it('returns ok:true with the validated plan', async () => {
    const store = freshStore();
    const run = seedPlanningRun(store);
    const client = fakeClient([toolUseResponse(validPlanInput)]);
    const result = await runPlanner(
      { client, store, runId: run.id, now: () => NOW },
      { spec: sampleSpec(), targetRepoPath: target },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.filesToTouch).toHaveLength(2);
      expect(result.usages).toHaveLength(1);
    }
  });

  it('uses Sonnet pricing for cost (not Haiku)', async () => {
    const store = freshStore();
    const run = seedPlanningRun(store);
    const client = fakeClient([
      toolUseResponse(validPlanInput, {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ]);
    const result = await runPlanner(
      { client, store, runId: run.id, now: () => NOW },
      { spec: sampleSpec(), targetRepoPath: target },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1M input tokens at $3/MTok = $3.00 (Sonnet); Haiku would be $1.00.
      expect(result.usages[0]?.costUsd).toBeCloseTo(3.0, 2);
    }
  });
});

describe('runPlanner: retry on invalid output', () => {
  it('retries once with feedback when call 1 is invalid', async () => {
    const store = freshStore();
    const run = seedPlanningRun(store);
    const invalid = {
      ...validPlanInput,
      plan: { ...validPlanInput.plan, filesToTouch: [] },
    };
    const client = fakeClient([
      toolUseResponse(invalid),
      toolUseResponse(validPlanInput),
    ]);
    const result = await runPlanner(
      { client, store, runId: run.id, now: () => NOW },
      { spec: sampleSpec(), targetRepoPath: target },
    );
    expect(result.ok).toBe(true);
    expect(result.usages).toHaveLength(2);
  });

  it('returns invalid_output when both calls fail validation', async () => {
    const store = freshStore();
    const run = seedPlanningRun(store);
    const invalid = {
      ...validPlanInput,
      plan: { ...validPlanInput.plan, approach: '' },
    };
    const client = fakeClient([
      toolUseResponse(invalid),
      toolUseResponse(invalid),
    ]);
    const result = await runPlanner(
      { client, store, runId: run.id, now: () => NOW },
      { spec: sampleSpec(), targetRepoPath: target },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_output');
      expect(result.usages).toHaveLength(2);
    }
  });

  it('applies record_token_usage for call 1 BEFORE the retry (§F3)', async () => {
    const store = freshStore();
    const run = seedPlanningRun(store);
    const invalid = { ...validPlanInput, plan: { ...validPlanInput.plan, risks: 'no risks' as unknown as string[] } };
    const client = fakeClient([
      toolUseResponse(invalid, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      toolUseResponse(validPlanInput, { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    await runPlanner(
      { client, store, runId: run.id, now: () => NOW },
      { spec: sampleSpec(), targetRepoPath: target },
    );
    const events = store.listEvents(run.id);
    const tokenEvents = events.filter((e) => e.event.type === 'record_token_usage');
    expect(tokenEvents).toHaveLength(2);
    if (tokenEvents[0]?.event.type === 'record_token_usage' && tokenEvents[1]?.event.type === 'record_token_usage') {
      expect(tokenEvents[0].event.tokens).toBe(110);
      expect(tokenEvents[1].event.tokens).toBe(220);
    }
  });
});

describe('runPlanner: rejection + SDK errors', () => {
  it('returns ok:false on rejection unimplementable', async () => {
    const store = freshStore();
    const run = seedPlanningRun(store);
    const client = fakeClient([
      toolUseResponse({
        kind: 'rejection',
        rejection: {
          reason: 'unimplementable',
          message: 'spec references files that do not exist',
        },
      }),
    ]);
    const result = await runPlanner(
      { client, store, runId: run.id, now: () => NOW },
      { spec: sampleSpec(), targetRepoPath: target },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unimplementable');
      expect(result.message).toContain('do not exist');
    }
  });

  it('returns sdk_error when the SDK throws', async () => {
    const store = freshStore();
    const run = seedPlanningRun(store);
    const client = fakeClient([new Error('rate limited')]);
    const result = await runPlanner(
      { client, store, runId: run.id, now: () => NOW },
      { spec: sampleSpec(), targetRepoPath: target },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sdk_error');
      expect(result.usages).toEqual([]);
    }
  });
});
