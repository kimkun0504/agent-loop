import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
  type Spec,
  type Verdict,
} from '@agent-loop/core';
import { openDb, applyEvent } from '@agent-loop/runtime';
import { inspect } from '../src/commands/inspect.js';

let home: string;
let stdout: string[];
let stderr: string[];
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-loop-inspect-'));
  process.env['AGENT_LOOP_HOME'] = home;
  stdout = [];
  stderr = [];
  origOut = process.stdout.write.bind(process.stdout);
  origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    stdout.push(typeof s === 'string' ? s : s.toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    stderr.push(typeof s === 'string' ? s : s.toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  delete process.env['AGENT_LOOP_HOME'];
  rmSync(home, { recursive: true, force: true });
});

function out(): string {
  return stdout.join('');
}
function err(): string {
  return stderr.join('');
}

const NOW = '2026-05-23T15:00:00.000Z';

function seedFullRun(): { runId: RunId; specId: SpecId } {
  const store = openDb(join(home, 'runs.db'));
  const runId = RunId('run-demo');
  const specId = SpecId('spec-demo');
  store.insertRun({
    id: runId,
    taskId: TaskId('task-1'),
    artifactDir: '/runs/run-demo',
    branch: 'agent/run-demo',
    phase: 'queued',
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  });
  const spec: Spec = {
    id: specId,
    runId,
    title: 'Demo task',
    description: 'A description across\ntwo lines.',
    fileScope: ['src/**/*.js'],
    acceptanceCriteria: ['ac one', 'ac two'],
    testCommands: ['npm test'],
    budget: DEFAULT_BUDGET,
    createdAt: NOW,
  };
  store.insertSpec(spec);
  // Apply a couple of events.
  applyEvent(store, runId, { type: 'start_triage' }, NOW);
  applyEvent(store, runId, { type: 'triage_succeeded', specId }, NOW);
  // Record a verdict directly.
  const v: Verdict = {
    runId,
    pass: true,
    testResults: [
      { command: 'npm test', exitCode: 0, durationMs: 1234, outputSummary: 'ok' },
    ],
    semanticCheck: { matches: true, reasoning: 'stub' },
    createdAt: NOW,
  };
  store.insertVerdict(v);
  return { runId, specId };
}

describe('inspect command', () => {
  it('exits 1 with a clear error when the run is not found', async () => {
    const code = await inspect('does-not-exist');
    expect(code).toBe(1);
    expect(err()).toContain('run not found');
  });

  it('prints the run detail header', async () => {
    const { runId } = seedFullRun();
    const code = await inspect(runId);
    expect(code).toBe(0);
    expect(out()).toContain('id          run-demo');
    expect(out()).toContain('branch      agent/run-demo');
  });

  it('prints the spec section when a spec exists', async () => {
    const { runId } = seedFullRun();
    await inspect(runId);
    expect(out()).toContain('--- Spec');
    expect(out()).toContain('title       Demo task');
    expect(out()).toContain('ac one');
    expect(out()).toContain('npm test');
  });

  it('prints each verdict in order, including pass/fail and per-command results', async () => {
    const { runId } = seedFullRun();
    await inspect(runId);
    expect(out()).toContain('--- Verdict #1 (PASS)');
    expect(out()).toContain('npm test -> exit 0, 1234ms');
  });

  it('prints the event log in chronological order with payload summaries', async () => {
    const { runId } = seedFullRun();
    await inspect(runId);
    const o = out();
    expect(o).toContain('--- Events');
    expect(o).toContain('start_triage');
    expect(o).toContain('triage_succeeded');
    // payload summary for triage_succeeded includes specId
    expect(o).toContain('specId=spec-demo');
    // chronological — start_triage before triage_succeeded
    expect(o.indexOf('start_triage')).toBeLessThan(o.indexOf('triage_succeeded'));
  });

  it('handles a run with no spec gracefully (omits the spec section)', async () => {
    const store = openDb(join(home, 'runs.db'));
    store.insertRun({
      id: RunId('run-bare'),
      taskId: TaskId('task-1'),
      artifactDir: '/runs/run-bare',
      branch: 'agent/run-bare',
      phase: 'queued',
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
      attemptCount: 0,
      tokensSpent: 0,
      secondsSpent: 0,
    });
    await inspect('run-bare');
    expect(out()).not.toContain('--- Spec');
  });
});
