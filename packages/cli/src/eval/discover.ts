/**
 * Discover eval task fixtures under <root>/tasks/.
 *
 * A task is valid if it has all three contract files: task.md (non-empty),
 * expected.json (valid JSON with testCommands non-empty), and base/ (a
 * directory containing at least one file). Invalid directories are skipped
 * with a warn rather than failing the whole discovery — surfaces the
 * problem in the report instead of blocking the run.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { EvalTask, EvalExpected } from './types.js';

export interface DiscoverResult {
  tasks: EvalTask[];
  skipped: Array<{ name: string; reason: string }>;
}

export function discoverTasks(evalsRoot: string): DiscoverResult {
  const tasksDir = join(evalsRoot, 'tasks');
  if (!existsSync(tasksDir)) {
    return { tasks: [], skipped: [] };
  }

  const tasks: EvalTask[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const entry of readdirSync(tasksDir).sort()) {
    const rootPath = join(tasksDir, entry);
    if (!isDir(rootPath)) continue;

    const validation = validateTaskDir(entry, rootPath);
    if ('error' in validation) {
      skipped.push({ name: entry, reason: validation.error });
      continue;
    }
    tasks.push(validation.task);
  }

  return { tasks, skipped };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

type Validation = { task: EvalTask } | { error: string };

function validateTaskDir(name: string, rootPath: string): Validation {
  const taskMdPath = join(rootPath, 'task.md');
  const expectedPath = join(rootPath, 'expected.json');
  const basePath = join(rootPath, 'base');

  if (!existsSync(taskMdPath)) return { error: 'missing task.md' };
  if (!existsSync(expectedPath)) return { error: 'missing expected.json' };
  if (!existsSync(basePath) || !isDir(basePath)) {
    return { error: 'missing base/ directory' };
  }

  const taskMd = readFileSync(taskMdPath, 'utf8');
  if (taskMd.trim().length === 0) return { error: 'task.md is empty' };

  let expected: EvalExpected;
  try {
    const raw = JSON.parse(readFileSync(expectedPath, 'utf8'));
    expected = validateExpected(raw);
  } catch (err) {
    return { error: `expected.json: ${String(err)}` };
  }

  if (!hasAnyFile(basePath)) {
    return { error: 'base/ contains no files' };
  }

  return {
    task: { name, rootPath, basePath, taskMd, expected },
  };
}

function validateExpected(raw: unknown): EvalExpected {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not an object');
  }
  const o = raw as Record<string, unknown>;
  const acceptance = o['acceptanceCriteria'];
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    throw new Error('acceptanceCriteria must be a non-empty array');
  }
  if (!acceptance.every((s) => typeof s === 'string')) {
    throw new Error('acceptanceCriteria must be strings');
  }
  const commands = o['testCommands'];
  if (!Array.isArray(commands)) {
    throw new Error('testCommands must be an array (may be empty)');
  }
  if (!commands.every((s) => typeof s === 'string')) {
    throw new Error('testCommands must be strings');
  }
  const result: EvalExpected = {
    acceptanceCriteria: acceptance as string[],
    testCommands: commands as string[],
  };
  const fileStateChecks = o['fileStateChecks'];
  if (fileStateChecks !== undefined) {
    if (!Array.isArray(fileStateChecks)) {
      throw new Error('fileStateChecks must be an array when present');
    }
    const validTypes = new Set(['unchanged', 'deleted', 'exists', 'absent']);
    for (let i = 0; i < fileStateChecks.length; i++) {
      const c = fileStateChecks[i];
      if (
        c === null ||
        typeof c !== 'object' ||
        Array.isArray(c)
      ) {
        throw new Error(`fileStateChecks[${i}]: not an object`);
      }
      const obj = c as Record<string, unknown>;
      if (typeof obj['type'] !== 'string' || !validTypes.has(obj['type'])) {
        throw new Error(
          `fileStateChecks[${i}].type: must be one of unchanged, deleted, exists, absent`,
        );
      }
      if (typeof obj['path'] !== 'string' || obj['path'].length === 0) {
        throw new Error(`fileStateChecks[${i}].path: missing or empty`);
      }
    }
    result.fileStateChecks = fileStateChecks as NonNullable<
      EvalExpected['fileStateChecks']
    >;
  }
  return result;
}

function hasAnyFile(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isFile()) return true;
      if (s.isDirectory() && hasAnyFile(p)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}
