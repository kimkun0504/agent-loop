/**
 * Tests for runVerifier — the composer of exit-code + semantic verification.
 *
 * The diff runner is stubbed (no actual git execution). The Anthropic client
 * is stubbed. The exit-code verifier IS exercised end-to-end via the existing
 * runCommand path against a real temp directory, since stubbing the entire
 * exitCode helper would lose composition coverage.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunId, SpecId, TaskId, createRun, type Spec } from '@agent-loop/core';
import { runVerifier } from '../../src/verifier/index.js';
import type { AnthropicClient } from '../../src/agents/sdkClient.js';
import type { RunCommandResult } from '../../src/proc/run.js';

const NOW = '2026-05-23T00:00:00.000Z';

function freshRun() {
  return createRun({
    id: RunId('run-test'),
    taskId: TaskId('local:hardcoded'),
    artifactDir: '/dev/null',
    branch: 'agent/run-test',
    now: NOW,
  });
}

function makeSpec(
  testCommands: string[],
  acceptanceCriteria: string[],
): Spec {
  return {
    id: SpecId('spec-test'),
    runId: RunId('run-test'),
    title: 't',
    description: 'd',
    fileScope: ['src/**'],
    acceptanceCriteria,
    testCommands,
    budget: { maxSeconds: 60, maxTokens: 100_000, maxCostUsd: 1 },
    createdAt: NOW,
  };
}

function mkPassingScript(dir: string): string {
  const path = join(dir, 'pass.sh');
  writeFileSync(path, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

function mkFailingScript(dir: string): string {
  const path = join(dir, 'fail.sh');
  writeFileSync(path, '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(path, 0o755);
  return path;
}

function clientWithJudgments(perCriterion: Array<{
  criterion: string;
  met: boolean;
  reasoning: string;
}>): AnthropicClient {
  return {
    messages: {
      create: async () =>
        ({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu',
              name: 'submit_verdict',
              input: { perCriterion },
            },
          ],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 500,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }) as unknown,
    },
  } as unknown as AnthropicClient;
}

const stubDiffRunner = async (): Promise<RunCommandResult> => ({
  exitCode: 0,
  stdout: 'diff --git a/src/a b/src/a\n+new line\n',
  stderr: '',
  durationMs: 1,
  timedOut: false,
  spawnFailed: false,
});

describe('runVerifier: composition', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-loop-runverifier-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('exit-code passes + semantic passes → verdict.pass=true', async () => {
    mkPassingScript(dir);
    const spec = makeSpec(['./pass.sh'], ['c1', 'c2']);
    const client = clientWithJudgments([
      { criterion: 'c1', met: true, reasoning: 'r1' },
      { criterion: 'c2', met: true, reasoning: 'r2' },
    ]);
    const r = await runVerifier(freshRun(), spec, {
      cwd: dir, client, diffRunner: stubDiffRunner,
    });
    expect(r.verdict.pass).toBe(true);
    expect(r.verdict.semanticCheck.matches).toBe(true);
    expect(r.verdict.semanticCheck.perCriterion).toHaveLength(2);
    expect(r.usages).toHaveLength(1);
  });

  it('exit-code fails → semantic NOT called → verdict.pass=false', async () => {
    mkFailingScript(dir);
    const spec = makeSpec(['./fail.sh'], ['c1']);
    let semanticCallCount = 0;
    const client: AnthropicClient = {
      messages: {
        create: async () => {
          semanticCallCount++;
          throw new Error('should not be called');
        },
      },
    } as unknown as AnthropicClient;
    const r = await runVerifier(freshRun(), spec, {
      cwd: dir, client, diffRunner: stubDiffRunner,
    });
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.semanticCheck.matches).toBe(false);
    expect(r.verdict.semanticCheck.perCriterion).toBeUndefined();
    expect(semanticCallCount).toBe(0);
    expect(r.usages).toHaveLength(0);
  });

  it('exit-code passes + semantic matches:false → verdict.pass=false', async () => {
    mkPassingScript(dir);
    const spec = makeSpec(['./pass.sh'], ['c1', 'c2']);
    const client = clientWithJudgments([
      { criterion: 'c1', met: true, reasoning: 'r1' },
      { criterion: 'c2', met: false, reasoning: 'criterion 2 not met' },
    ]);
    const r = await runVerifier(freshRun(), spec, {
      cwd: dir, client, diffRunner: stubDiffRunner,
    });
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.semanticCheck.matches).toBe(false);
    expect(r.verdict.semanticCheck.perCriterion?.[1]?.met).toBe(false);
  });
});

describe('runVerifier: missing client / no criteria', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-loop-runverifier-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('no client → exit-code-only verdict; semantic skipped with reasoning', async () => {
    mkPassingScript(dir);
    const spec = makeSpec(['./pass.sh'], ['c1']);
    const r = await runVerifier(freshRun(), spec, { cwd: dir });
    expect(r.verdict.pass).toBe(true);
    expect(r.verdict.semanticCheck.reasoning).toMatch(/no Anthropic client/);
    expect(r.verdict.semanticCheck.perCriterion).toBeUndefined();
  });

  it('spec with no acceptance criteria → semantic trivially passes', async () => {
    mkPassingScript(dir);
    const spec = makeSpec(['./pass.sh'], []);
    const client = clientWithJudgments([
      { criterion: 'unused', met: true, reasoning: 'r' },
    ]);
    const r = await runVerifier(freshRun(), spec, {
      cwd: dir, client, diffRunner: stubDiffRunner,
    });
    expect(r.verdict.pass).toBe(true);
    expect(r.verdict.semanticCheck.reasoning).toMatch(/no acceptance criteria/);
  });
});

describe('runVerifier: SDK error policy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-loop-runverifier-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('default strict: SDK error → verdict.pass=false', async () => {
    mkPassingScript(dir);
    const spec = makeSpec(['./pass.sh'], ['c1']);
    const client: AnthropicClient = {
      messages: { create: async () => { throw new Error('rate_limit'); } },
    } as unknown as AnthropicClient;
    const r = await runVerifier(freshRun(), spec, {
      cwd: dir, client, diffRunner: stubDiffRunner,
    });
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.semanticCheck.reasoning).toMatch(/semantic verifier failed/);
    expect(r.verdict.semanticCheck.reasoning).toMatch(/rate_limit/);
  });

  it('semanticOnSdkError=skip: SDK error → exit-code verdict stands', async () => {
    mkPassingScript(dir);
    const spec = makeSpec(['./pass.sh'], ['c1']);
    const client: AnthropicClient = {
      messages: { create: async () => { throw new Error('network'); } },
    } as unknown as AnthropicClient;
    const r = await runVerifier(freshRun(), spec, {
      cwd: dir, client,
      diffRunner: stubDiffRunner,
      semanticOnSdkError: 'skip',
    });
    expect(r.verdict.pass).toBe(true);
    expect(r.verdict.semanticCheck.reasoning).toMatch(/skipped/);
  });
});

