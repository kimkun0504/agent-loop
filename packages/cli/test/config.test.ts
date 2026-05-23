import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, ensureAgentLoopDirs } from '../src/config.js';

const ORIG_HOME = process.env['AGENT_LOOP_HOME'];

beforeEach(() => {
  delete process.env['AGENT_LOOP_HOME'];
});

afterEach(() => {
  if (ORIG_HOME === undefined) {
    delete process.env['AGENT_LOOP_HOME'];
  } else {
    process.env['AGENT_LOOP_HOME'] = ORIG_HOME;
  }
});

describe('resolvePaths', () => {
  it('defaults home to ~/.agent-loop', () => {
    const paths = resolvePaths();
    expect(paths.home).toMatch(/\/\.agent-loop$/);
  });

  it('honors $AGENT_LOOP_HOME', () => {
    process.env['AGENT_LOOP_HOME'] = '/some/custom/path';
    const paths = resolvePaths();
    expect(paths.home).toBe('/some/custom/path');
  });

  it('explicit argument beats the env var', () => {
    process.env['AGENT_LOOP_HOME'] = '/env/path';
    const paths = resolvePaths('/arg/path');
    expect(paths.home).toBe('/arg/path');
  });

  it('derives all subpaths from home', () => {
    const paths = resolvePaths('/home/x');
    expect(paths.dbPath).toBe('/home/x/runs.db');
    expect(paths.worktreesDir).toBe('/home/x/worktrees');
    expect(paths.artifactsDir).toBe('/home/x/artifacts');
    expect(paths.cliLogPath).toBe('/home/x/cli.log');
    expect(paths.stopFilePath).toBe('/home/x/STOP');
  });

  it('STOP lives at the workspace root (runtime expects <cwd>/STOP)', () => {
    const paths = resolvePaths('/home/x');
    expect(paths.stopFilePath).toBe(join(paths.home, 'STOP'));
  });
});

describe('ensureAgentLoopDirs', () => {
  it('creates home, worktrees, and artifacts dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-config-'));
    try {
      const home = join(root, 'work');
      const paths = resolvePaths(home);
      ensureAgentLoopDirs(paths);
      expect(existsSync(paths.home)).toBe(true);
      expect(existsSync(paths.worktreesDir)).toBe(true);
      expect(existsSync(paths.artifactsDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — second call does not throw on existing dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-config-'));
    try {
      const paths = resolvePaths(join(root, 'work'));
      ensureAgentLoopDirs(paths);
      ensureAgentLoopDirs(paths);
      expect(existsSync(paths.worktreesDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not pre-create the db file or STOP file', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-loop-config-'));
    try {
      const paths = resolvePaths(join(root, 'work'));
      ensureAgentLoopDirs(paths);
      expect(existsSync(paths.dbPath)).toBe(false);
      expect(existsSync(paths.stopFilePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
