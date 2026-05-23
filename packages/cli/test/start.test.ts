/**
 * Tests for `start` cover the pre-flight validation paths. The full happy
 * path requires the real `claude` CLI + GitHub access and is exercised by
 * the manual smoke run (CLI step 8).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/commands/start.js';

const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

let home: string;
let stdout: string[];
let stderr: string[];
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-loop-start-'));
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

function err(): string {
  return stderr.join('');
}

async function gitInit(path: string): Promise<void> {
  await execa('git', ['init', '-b', 'main', path]);
  writeFileSync(join(path, 'README.md'), '# fixture\n');
  await execa('git', [...GIT_ID, 'add', '.'], { cwd: path });
  await execa('git', [...GIT_ID, 'commit', '-m', 'init'], { cwd: path });
}

describe('start: pre-flight validation', () => {
  it('refuses an unknown spec name', async () => {
    const target = join(home, 'repo');
    mkdirSync(target);
    await gitInit(target);
    const code = await start({ spec: 'not-a-real-spec', target });
    expect(code).toBe(1);
    expect(err()).toContain('unknown spec');
  });

  it('refuses a non-existent target path', async () => {
    const code = await start({
      spec: 'hardcoded',
      target: '/this/path/does/not/exist',
    });
    expect(code).toBe(1);
    expect(err()).toContain('target path does not exist');
  });

  it('refuses a target that is not a git repo', async () => {
    const notRepo = join(home, 'not-a-repo');
    mkdirSync(notRepo);
    writeFileSync(join(notRepo, 'file.txt'), 'hello\n');
    const code = await start({ spec: 'hardcoded', target: notRepo });
    expect(code).toBe(1);
    expect(err().toLowerCase()).toContain('git status failed');
  });

  it('refuses a dirty target (uncommitted changes)', async () => {
    const target = join(home, 'dirty-repo');
    mkdirSync(target);
    await gitInit(target);
    // Make it dirty: modify a tracked file.
    writeFileSync(join(target, 'README.md'), '# changed\n');
    const code = await start({ spec: 'hardcoded', target });
    expect(code).toBe(1);
    expect(err()).toContain('is dirty');
    expect(err()).toContain('M README.md');
  });

  it('refuses a target with untracked files', async () => {
    const target = join(home, 'untracked-repo');
    mkdirSync(target);
    await gitInit(target);
    writeFileSync(join(target, 'scratch.txt'), 'untracked\n');
    const code = await start({ spec: 'hardcoded', target });
    expect(code).toBe(1);
    expect(err()).toContain('is dirty');
    expect(err()).toContain('?? scratch.txt');
  });

  it('error message names the spec registry contents on unknown spec', async () => {
    const target = join(home, 'repo');
    mkdirSync(target);
    await gitInit(target);
    await start({ spec: 'nope', target });
    expect(err()).toContain('hardcoded');
  });
}, 30_000);
