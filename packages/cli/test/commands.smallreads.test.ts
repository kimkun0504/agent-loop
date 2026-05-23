/**
 * Tests for stop, status, and list — the small read/touch commands.
 *
 * Each command uses resolvePaths() which reads $AGENT_LOOP_HOME, so we
 * point it at a fresh tmpdir per test. stdout is captured via
 * process.stdout.write monkey-patching (vitest sandboxes the process).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunId,
  TaskId,
  type Run,
} from '@agent-loop/core';
import { openDb } from '@agent-loop/runtime';
import { stop } from '../src/commands/stop.js';
import { list } from '../src/commands/list.js';
import { status } from '../src/commands/status.js';
import { formatRunsTable, formatRunDetail } from '../src/format.js';

let home: string;
let stdout: string[];
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-loop-cli-smoke-'));
  process.env['AGENT_LOOP_HOME'] = home;
  stdout = [];
  origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    stdout.push(typeof s === 'string' ? s : s.toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = origWrite;
  delete process.env['AGENT_LOOP_HOME'];
  rmSync(home, { recursive: true, force: true });
});

function output(): string {
  return stdout.join('');
}

function seedRun(phase: Run['phase'], idSuffix: string, updatedAt: string): void {
  const store = openDb(join(home, 'runs.db'));
  store.insertRun({
    id: RunId(`run-${idSuffix}`),
    taskId: TaskId('task-1'),
    artifactDir: `/runs/run-${idSuffix}`,
    branch: `agent/run-${idSuffix}`,
    phase,
    version: 0,
    createdAt: updatedAt,
    updatedAt,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  });
}

describe('stop command', () => {
  it('writes the STOP file', async () => {
    const code = await stop({});
    expect(code).toBe(0);
    expect(existsSync(join(home, 'STOP'))).toBe(true);
    expect(output()).toContain('wrote STOP file');
  });

  it('writes an empty file (presence is the signal)', async () => {
    await stop({});
    expect(readFileSync(join(home, 'STOP'), 'utf8')).toBe('');
  });

  it('--clear removes an existing STOP file', async () => {
    writeFileSync(join(home, 'STOP'), '');
    const code = await stop({ clear: true });
    expect(code).toBe(0);
    expect(existsSync(join(home, 'STOP'))).toBe(false);
    expect(output()).toContain('cleared STOP file');
  });

  it('--clear is idempotent when STOP is absent', async () => {
    const code = await stop({ clear: true });
    expect(code).toBe(0);
    expect(output()).toContain('no STOP file present');
  });
});

describe('list command', () => {
  it('prints "no runs yet" on an empty DB', async () => {
    const code = await list();
    expect(code).toBe(0);
    expect(output()).toContain('no runs yet');
  });

  it('prints a table with each run', async () => {
    seedRun('done', 'a1', '2026-05-23T15:00:01.000Z');
    seedRun('verifying', 'b2', '2026-05-23T15:00:02.000Z');
    const code = await list();
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('RUN-ID');
    expect(out).toContain('PHASE');
    expect(out).toContain('run-a1');
    expect(out).toContain('run-b2');
    expect(out).toContain('done');
    expect(out).toContain('verifying');
  });

  it('orders rows most recent first', async () => {
    seedRun('done', 'old', '2026-01-01T00:00:00.000Z');
    seedRun('done', 'new', '2026-05-23T15:00:00.000Z');
    await list();
    const out = output();
    const newIdx = out.indexOf('run-new');
    const oldIdx = out.indexOf('run-old');
    expect(newIdx).toBeLessThan(oldIdx);
  });
});

describe('status command', () => {
  it('says "no active runs" when only terminal runs exist', async () => {
    seedRun('done', 'a1', '2026-05-23T15:00:00.000Z');
    seedRun('failed', 'a2', '2026-05-23T15:00:01.000Z');
    const code = await status();
    expect(code).toBe(0);
    expect(output().trim()).toBe('no active runs');
  });

  it('says "no active runs" on an empty DB', async () => {
    const code = await status();
    expect(code).toBe(0);
    expect(output().trim()).toBe('no active runs');
  });

  it('prints the most recent non-terminal run', async () => {
    seedRun('done', 'old', '2026-01-01T00:00:00.000Z');
    seedRun('executing', 'active', '2026-05-23T15:00:00.000Z');
    const code = await status();
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('run-active');
    expect(out).toContain('executing');
    expect(out).not.toContain('run-old');
  });
});

describe('formatters', () => {
  const sampleRun: Run = {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    artifactDir: '/runs/run-1',
    branch: 'agent/run-1',
    phase: 'verifying',
    version: 3,
    createdAt: '2026-05-23T15:00:00.000Z',
    updatedAt: '2026-05-23T15:01:00.000Z',
    attemptCount: 0,
    tokensSpent: 1234,
    secondsSpent: 56,
  };

  it('formatRunsTable produces aligned columns', () => {
    const out = formatRunsTable([sampleRun]);
    expect(out).toContain('RUN-ID');
    expect(out).toContain('PHASE');
    expect(out).toContain('UPDATED');
    expect(out).toContain('BRANCH');
    expect(out).toContain('run-1');
    expect(out).toContain('agent/run-1');
  });

  it('formatRunDetail includes failure when present', () => {
    const failed: Run = {
      ...sampleRun,
      phase: 'failed',
      failure: {
        category: 'execution_error',
        message: 'boom',
        phase: 'executing',
      },
    };
    const out = formatRunDetail(failed);
    expect(out).toContain('[execution_error] boom');
  });

  it('formatRunDetail omits specId when absent', () => {
    const out = formatRunDetail(sampleRun);
    expect(out).not.toContain('specId');
  });
});
