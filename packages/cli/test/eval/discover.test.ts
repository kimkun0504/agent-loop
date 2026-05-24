import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTasks } from '../../src/eval/discover.js';

let root: string;
let evalsRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-loop-eval-discover-'));
  evalsRoot = join(root, 'evals');
  mkdirSync(join(evalsRoot, 'tasks'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeTaskDir(
  name: string,
  opts: {
    taskMd?: string;
    expected?: unknown;
    baseFile?: { path: string; content: string };
    skipTaskMd?: boolean;
    skipExpected?: boolean;
    skipBase?: boolean;
  },
): void {
  const dir = join(evalsRoot, 'tasks', name);
  mkdirSync(dir, { recursive: true });
  if (!opts.skipTaskMd) {
    writeFileSync(join(dir, 'task.md'), opts.taskMd ?? 'Do the thing.');
  }
  if (!opts.skipExpected) {
    writeFileSync(
      join(dir, 'expected.json'),
      JSON.stringify(
        opts.expected ?? {
          acceptanceCriteria: ['must work'],
          testCommands: ['npm test'],
        },
      ),
    );
  }
  if (!opts.skipBase) {
    const baseFile = opts.baseFile ?? { path: 'src/index.js', content: 'export {};' };
    const filePath = join(dir, 'base', baseFile.path);
    mkdirSync(join(dir, 'base', baseFile.path.split('/').slice(0, -1).join('/')), {
      recursive: true,
    });
    writeFileSync(filePath, baseFile.content);
  }
}

describe('discoverTasks', () => {
  it('returns empty when evals/tasks does not exist', () => {
    rmSync(evalsRoot, { recursive: true });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('discovers valid tasks and parses task.md + expected.json', () => {
    makeTaskDir('alpha', {
      taskMd: 'Alpha task body',
      expected: { acceptanceCriteria: ['ac1', 'ac2'], testCommands: ['npm test'] },
    });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]?.name).toBe('alpha');
    expect(r.tasks[0]?.taskMd).toBe('Alpha task body');
    expect(r.tasks[0]?.expected.acceptanceCriteria).toEqual(['ac1', 'ac2']);
    expect(r.tasks[0]?.expected.testCommands).toEqual(['npm test']);
  });

  it('returns tasks sorted by name (deterministic)', () => {
    makeTaskDir('charlie', {});
    makeTaskDir('alpha', {});
    makeTaskDir('bravo', {});
    const r = discoverTasks(evalsRoot);
    expect(r.tasks.map((t) => t.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('skips dirs missing task.md', () => {
    makeTaskDir('broken', { skipTaskMd: true });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'broken', reason: 'missing task.md' }]);
  });

  it('skips dirs missing expected.json', () => {
    makeTaskDir('broken', { skipExpected: true });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('expected.json');
  });

  it('skips dirs missing base/', () => {
    makeTaskDir('broken', { skipBase: true });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('base/');
  });

  it('skips dirs with empty task.md', () => {
    makeTaskDir('blank', { taskMd: '   \n  ' });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('empty');
  });

  it('skips when expected.json has empty acceptanceCriteria', () => {
    makeTaskDir('no-criteria', {
      expected: { acceptanceCriteria: [], testCommands: ['npm test'] },
    });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('acceptanceCriteria');
  });

  it('accepts expected.json with empty testCommands (semantic-only verification)', () => {
    makeTaskDir('docs-only', {
      expected: { acceptanceCriteria: ['README is updated'], testCommands: [] },
    });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]?.expected.testCommands).toEqual([]);
  });

  it('reads calibrationTestCommands when present', () => {
    makeTaskDir('with-anchor', {
      expected: {
        acceptanceCriteria: ['x is y'],
        testCommands: ['npm test'],
        calibrationTestCommands: ['! grep -r foo src/'],
      },
    });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks[0]?.expected.calibrationTestCommands).toEqual([
      '! grep -r foo src/',
    ]);
  });

  it('rejects calibrationTestCommands that is not an array', () => {
    makeTaskDir('bad-anchor', {
      expected: {
        acceptanceCriteria: ['x'],
        testCommands: ['npm test'],
        calibrationTestCommands: 'not an array' as unknown as string[],
      },
    });
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('calibrationTestCommands');
  });

  it('skips when expected.json is malformed JSON', () => {
    const dir = join(evalsRoot, 'tasks', 'bad');
    mkdirSync(join(dir, 'base'), { recursive: true });
    writeFileSync(join(dir, 'task.md'), 'x');
    writeFileSync(join(dir, 'expected.json'), '{ not json');
    writeFileSync(join(dir, 'base', 'a.txt'), 'x');
    const r = discoverTasks(evalsRoot);
    expect(r.tasks).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('expected.json');
  });
});
