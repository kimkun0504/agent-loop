import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isStopRequested, STOP_FILE_NAME } from '../../src/fs/stop.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-loop-stop-'));
}

describe('isStopRequested', () => {
  it('returns false when no STOP file is present', () => {
    const dir = freshDir();
    try {
      expect(isStopRequested(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when STOP exists in the given directory', () => {
    const dir = freshDir();
    try {
      writeFileSync(join(dir, STOP_FILE_NAME), '');
      expect(isStopRequested(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not recurse into subdirectories', () => {
    const dir = freshDir();
    try {
      const sub = join(dir, 'sub');
      mkdirSync(sub);
      writeFileSync(join(sub, STOP_FILE_NAME), '');
      expect(isStopRequested(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true even when the STOP file is empty', () => {
    const dir = freshDir();
    try {
      writeFileSync(join(dir, STOP_FILE_NAME), '');
      expect(isStopRequested(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes the file name as a constant for callers (no magic strings)', () => {
    expect(STOP_FILE_NAME).toBe('STOP');
  });
});
