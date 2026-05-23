/**
 * ClaudeCliExecutor tests use `bash` as a stand-in for the `claude`
 * binary so we never call real Claude in CI. The executor's contract
 * (cwd, args, exit codes, timeout) doesn't depend on which binary is
 * spawned — we substitute via the `binary` and `extraArgs` constructor
 * options.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Run,
  type Spec,
  RunId,
  SpecId,
  TaskId,
  DEFAULT_BUDGET,
} from '@agent-loop/core';
import { ClaudeCliExecutor } from '../../src/executor/claude.js';

const NOW = '2026-01-01T00:00:00.000Z';

function sampleRun(): Run {
  return {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    artifactDir: '/runs/run-1',
    branch: 'agent/run-1',
    phase: 'executing',
    version: 4,
    createdAt: NOW,
    updatedAt: NOW,
    attemptCount: 0,
    tokensSpent: 0,
    secondsSpent: 0,
  };
}

function sampleSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: SpecId('spec-1'),
    runId: RunId('run-1'),
    title: 'Title',
    description: 'Description.',
    fileScope: ['src/**'],
    acceptanceCriteria: ['ac'],
    testCommands: ['true'],
    budget: { ...DEFAULT_BUDGET, maxSeconds: 5 },
    createdAt: NOW,
    ...overrides,
  };
}

describe('ClaudeCliExecutor', () => {
  it('returns ok=true when the fake binary exits 0', async () => {
    const executor = new ClaudeCliExecutor({
      binary: 'bash',
      extraArgs: ['-c', 'exit 0', '--'], // ignores subsequent args
    });
    const result = await executor.execute({
      run: sampleRun(),
      spec: sampleSpec(),
      worktreePath: process.cwd(),
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.spawnFailed).toBe(false);
  });

  it('returns ok=false with the non-zero exit code', async () => {
    const executor = new ClaudeCliExecutor({
      binary: 'bash',
      extraArgs: ['-c', 'exit 3', '--'],
    });
    const result = await executor.execute({
      run: sampleRun(),
      spec: sampleSpec(),
      worktreePath: process.cwd(),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('returns spawnFailed=true when the binary does not exist', async () => {
    const executor = new ClaudeCliExecutor({
      binary: 'this-binary-does-not-exist-9999',
    });
    const result = await executor.execute({
      run: sampleRun(),
      spec: sampleSpec(),
      worktreePath: process.cwd(),
    });
    expect(result.ok).toBe(false);
    expect(result.spawnFailed).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it('enforces spec.budget.maxSeconds as the wall-clock timeout', async () => {
    const executor = new ClaudeCliExecutor({
      binary: 'bash',
      extraArgs: ['-c', 'sleep 5', '--'],
    });
    const result = await executor.execute({
      run: sampleRun(),
      // 0 maxSeconds -> 0ms timeout -> instant timeout. Use a small int.
      spec: sampleSpec({ budget: { ...DEFAULT_BUDGET, maxSeconds: 1 } }),
      worktreePath: process.cwd(),
    });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    // Should not have waited 5s.
    expect(result.durationMs).toBeLessThan(3000);
  });

  it('runs the binary in the given worktree cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-exec-'));
    try {
      const executor = new ClaudeCliExecutor({
        binary: 'bash',
        // Print cwd, ignore the rest of the args by consuming with --.
        extraArgs: ['-c', 'pwd; exit 0', '--'],
      });
      const result = await executor.execute({
        run: sampleRun(),
        spec: sampleSpec(),
        worktreePath: dir,
      });
      const last = dir.split('/').slice(-1)[0]!;
      expect(result.outputLog).toContain(last);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the built prompt as the value of -p', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-exec-'));
    const outFile = join(dir, 'argv.txt');
    try {
      // Capture argv to a file so we can assert against it.
      const executor = new ClaudeCliExecutor({
        binary: 'bash',
        extraArgs: [
          '-c',
          // Write the value AFTER -p to outFile and exit.
          `for ((i=1; i<=$#; i++)); do if [ "\${!i}" = "-p" ]; then j=$((i+1)); echo "\${!j}" > ${outFile}; fi; done`,
          '--',
        ],
      });
      await executor.execute({
        run: sampleRun(),
        spec: sampleSpec({ title: 'Unique-title-for-prompt-assert-xyz' }),
        worktreePath: dir,
      });
      const captured = readFileSync(outFile, 'utf8');
      expect(captured).toContain('Unique-title-for-prompt-assert-xyz');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors a custom buildPrompt override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-exec-'));
    const outFile = join(dir, 'argv.txt');
    try {
      const executor = new ClaudeCliExecutor({
        binary: 'bash',
        extraArgs: [
          '-c',
          `for ((i=1; i<=$#; i++)); do if [ "\${!i}" = "-p" ]; then j=$((i+1)); echo "\${!j}" > ${outFile}; fi; done`,
          '--',
        ],
        buildPrompt: () => 'CUSTOM_PROMPT_TEXT',
      });
      await executor.execute({
        run: sampleRun(),
        spec: sampleSpec(),
        worktreePath: dir,
      });
      const captured = readFileSync(outFile, 'utf8');
      expect(captured.trim()).toBe('CUSTOM_PROMPT_TEXT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
