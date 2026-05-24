import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Run,
  type Spec,
  type Verdict,
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
} from '@agent-loop/core';
import {
  writeExecutorArtifacts,
  writeVerdictArtifact,
  writeSemanticDebugArtifact,
  type SemanticDebugArtifactJson,
  writeMetaArtifact,
  ARTIFACT_SCHEMA_VERSION,
  type ExecutorArtifactJson,
  type VerdictArtifactJson,
  type MetaArtifactJson,
} from '../../src/artifacts/write.js';

const NOW = '2026-05-23T17:00:00.000Z';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-loop-artifacts-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sampleRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    artifactDir: join(root, 'run-1'),
    branch: 'agent/run-1',
    phase: 'done',
    version: 7,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 1500,
    secondsSpent: 30,
    ...overrides,
  };
}

function sampleSpec(): Spec {
  return {
    id: SpecId('spec-1'),
    runId: RunId('run-1'),
    title: 'A task',
    description: 'desc',
    fileScope: ['src/**/*'],
    acceptanceCriteria: ['ac'],
    testCommands: ['npm test'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  };
}

function sampleVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    runId: RunId('run-1'),
    pass: true,
    testResults: [
      {
        command: 'npm test',
        exitCode: 0,
        durationMs: 1234,
        outputSummary: 'all good',
      },
    ],
    semanticCheck: { matches: true, reasoning: 'ok' },
    createdAt: NOW,
    ...overrides,
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('writeExecutorArtifacts', () => {
  it('writes executor.log with the raw outputLog', () => {
    const dir = join(root, 'run-1');
    writeExecutorArtifacts(dir, {
      ok: true,
      exitCode: 0,
      durationMs: 100,
      outputLog: 'agent transcript\nline 2',
      timedOut: false,
      spawnFailed: false,
    });
    expect(readFileSync(join(dir, 'executor.log'), 'utf8')).toBe(
      'agent transcript\nline 2',
    );
  });

  it('writes executor.json with schemaVersion 1 and the expected fields', () => {
    const dir = join(root, 'run-1');
    writeExecutorArtifacts(dir, {
      ok: false,
      exitCode: 1,
      durationMs: 500,
      outputLog: 'oops',
      timedOut: false,
      spawnFailed: false,
    });
    const parsed = readJson<ExecutorArtifactJson>(join(dir, 'executor.json'));
    expect(parsed.schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.durationMs).toBe(500);
    expect(parsed.timedOut).toBe(false);
    expect(parsed.spawnFailed).toBe(false);
  });

  it('includes usage in executor.json when provided', () => {
    const dir = join(root, 'run-1');
    writeExecutorArtifacts(dir, {
      ok: true,
      exitCode: 0,
      durationMs: 1,
      outputLog: '',
      timedOut: false,
      spawnFailed: false,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        costUsd: 0.01,
      },
    });
    const parsed = readJson<ExecutorArtifactJson>(join(dir, 'executor.json'));
    expect(parsed.usage?.inputTokens).toBe(100);
    expect(parsed.usage?.costUsd).toBeCloseTo(0.01);
  });

  it('creates the parent directory if missing', () => {
    const dir = join(root, 'deep', 'nested', 'run-x');
    writeExecutorArtifacts(dir, {
      ok: true, exitCode: 0, durationMs: 1, outputLog: '',
      timedOut: false, spawnFailed: false,
    });
    expect(existsSync(join(dir, 'executor.log'))).toBe(true);
  });
});

describe('writeVerdictArtifact', () => {
  it('writes verdict-001.json with schemaVersion and the full Verdict', () => {
    const dir = join(root, 'run-1');
    writeVerdictArtifact(dir, sampleVerdict(), 1);
    const parsed = readJson<VerdictArtifactJson>(join(dir, 'verdict-001.json'));
    expect(parsed.schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    expect(parsed.verdict.pass).toBe(true);
    expect(parsed.verdict.testResults[0]?.command).toBe('npm test');
  });

  it('zero-pads the index in the filename', () => {
    const dir = join(root, 'run-1');
    writeVerdictArtifact(dir, sampleVerdict(), 7);
    expect(existsSync(join(dir, 'verdict-007.json'))).toBe(true);
    expect(existsSync(join(dir, 'verdict-007.log'))).toBe(true);
  });

  it('writes a .log with per-command markers', () => {
    const dir = join(root, 'run-1');
    writeVerdictArtifact(
      dir,
      sampleVerdict({
        testResults: [
          { command: 'pnpm lint', exitCode: 0, durationMs: 200, outputSummary: 'lint ok' },
          { command: 'pnpm test', exitCode: 1, durationMs: 800, outputSummary: 'test fail' },
        ],
      }),
      2,
    );
    const log = readFileSync(join(dir, 'verdict-002.log'), 'utf8');
    expect(log).toContain('$ pnpm lint');
    expect(log).toContain('$ pnpm test');
    expect(log).toContain('exit 0, 200ms');
    expect(log).toContain('exit 1, 800ms');
    expect(log).toContain('lint ok');
    expect(log).toContain('test fail');
  });
});

describe('writeSemanticDebugArtifact', () => {
  it('writes verdict-NNN.semantic-debug.json with schemaVersion + debug payload', () => {
    const dir = join(root, 'run-1');
    writeSemanticDebugArtifact(
      dir,
      {
        systemPrompt: 'mock system prompt',
        finalOutcome: 'invalid_output',
        calls: [
          {
            userPrompt: 'call 1 prompt',
            rawToolInput: { perCriterion: { keyed: 'by criterion' } },
            validatorErrors: ['perCriterion is not an array'],
          },
          {
            userPrompt: 'call 2 retry prompt',
            rawToolInput: { perCriterion: 'still wrong' },
            validatorErrors: ['perCriterion is not an array'],
          },
        ],
      },
      1,
    );
    const parsed = readJson<SemanticDebugArtifactJson>(
      join(dir, 'verdict-001.semantic-debug.json'),
    );
    expect(parsed.schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    expect(parsed.debug.systemPrompt).toBe('mock system prompt');
    expect(parsed.debug.finalOutcome).toBe('invalid_output');
    expect(parsed.debug.calls).toHaveLength(2);
    expect(parsed.debug.calls[0]?.rawToolInput).toEqual({
      perCriterion: { keyed: 'by criterion' },
    });
    expect(parsed.debug.calls[0]?.validatorErrors).toEqual([
      'perCriterion is not an array',
    ]);
  });

  it('zero-pads the index in the filename', () => {
    const dir = join(root, 'run-1');
    writeSemanticDebugArtifact(
      dir,
      {
        systemPrompt: 's',
        finalOutcome: 'ok',
        calls: [
          { userPrompt: 'p', rawToolInput: { perCriterion: [] }, validatorErrors: ['e'] },
          { userPrompt: 'r', rawToolInput: { perCriterion: [] } },
        ],
      },
      7,
    );
    expect(existsSync(join(dir, 'verdict-007.semantic-debug.json'))).toBe(true);
  });
});

describe('writeMetaArtifact', () => {
  it('writes meta.json with schemaVersion and core Run fields', () => {
    const dir = join(root, 'run-1');
    writeMetaArtifact(dir, sampleRun());
    const meta = readJson<MetaArtifactJson>(join(dir, 'meta.json'));
    expect(meta.schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    expect(meta.runId).toBe('run-1');
    expect(meta.taskId).toBe('task-1');
    expect(meta.branch).toBe('agent/run-1');
    expect(meta.phase).toBe('done');
    expect(meta.tokensSpent).toBe(1500);
    expect(meta.secondsSpent).toBe(30);
  });

  it('includes prUrl when present', () => {
    const dir = join(root, 'run-1');
    writeMetaArtifact(
      dir,
      sampleRun({ prUrl: 'https://github.com/x/y/pull/1' }),
    );
    const meta = readJson<MetaArtifactJson>(join(dir, 'meta.json'));
    expect(meta.prUrl).toBe('https://github.com/x/y/pull/1');
  });

  it('omits prUrl when absent (no undefined leakage)', () => {
    const dir = join(root, 'run-1');
    writeMetaArtifact(dir, sampleRun());
    const meta = readJson<MetaArtifactJson>(join(dir, 'meta.json'));
    expect('prUrl' in meta).toBe(false);
  });

  it('includes failure when present', () => {
    const dir = join(root, 'run-1');
    writeMetaArtifact(
      dir,
      sampleRun({
        phase: 'failed',
        failure: {
          category: 'execution_error',
          message: 'crashed',
          phase: 'executing',
        },
      }),
    );
    const meta = readJson<MetaArtifactJson>(join(dir, 'meta.json'));
    expect(meta.failure?.category).toBe('execution_error');
    expect(meta.failure?.phase).toBe('executing');
  });

  it('includes a minimal spec summary when spec is provided', () => {
    const dir = join(root, 'run-1');
    writeMetaArtifact(dir, sampleRun(), sampleSpec());
    const meta = readJson<MetaArtifactJson>(join(dir, 'meta.json'));
    expect(meta.spec?.id).toBe('spec-1');
    expect(meta.spec?.title).toBe('A task');
    expect(meta.spec?.testCommands).toEqual(['npm test']);
    // Full description is NOT included — that lives in the DB / spec view.
    expect((meta.spec as unknown as { description?: string })?.description).toBeUndefined();
  });

  it('includes latestVerdict summary when verdict provided', () => {
    const dir = join(root, 'run-1');
    writeMetaArtifact(dir, sampleRun(), sampleSpec(), sampleVerdict());
    const meta = readJson<MetaArtifactJson>(join(dir, 'meta.json'));
    expect(meta.latestVerdict?.pass).toBe(true);
    expect(meta.latestVerdict?.testCount).toBe(1);
  });
});
