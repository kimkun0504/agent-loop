import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotenvFile, parseDotenv } from '../../src/config/dotenv.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-loop-dotenv-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseDotenv', () => {
  it('parses simple KEY=value pairs', () => {
    expect(parseDotenv('A=1\nB=2')).toEqual({ A: '1', B: '2' });
  });

  it('skips blank lines and comments', () => {
    expect(
      parseDotenv(['# header', '', 'A=1', '  ', '# another', 'B=2'].join('\n')),
    ).toEqual({ A: '1', B: '2' });
  });

  it('strips surrounding double quotes', () => {
    expect(parseDotenv('A="hello world"')).toEqual({ A: 'hello world' });
  });

  it('strips surrounding single quotes', () => {
    expect(parseDotenv("A='hello world'")).toEqual({ A: 'hello world' });
  });

  it('does NOT strip mismatched quotes', () => {
    expect(parseDotenv('A=\'hello"')).toEqual({ A: '\'hello"' });
  });

  it('preserves internal = signs in the value', () => {
    expect(parseDotenv('URL=https://x.com/y=z')).toEqual({ URL: 'https://x.com/y=z' });
  });

  it('skips lines without =', () => {
    expect(parseDotenv('NOEQUALS\nA=1')).toEqual({ A: '1' });
  });

  it('skips lines where the key is invalid', () => {
    expect(parseDotenv('1BAD=x\n_GOOD=ok\n-BAD=y')).toEqual({ _GOOD: 'ok' });
  });

  it('handles empty values', () => {
    expect(parseDotenv('A=\nB= ')).toEqual({ A: '', B: '' });
  });

  it('returns {} for empty input', () => {
    expect(parseDotenv('')).toEqual({});
  });
});

describe('loadDotenvFile', () => {
  it('reads and parses a real file', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'ANTHROPIC_API_KEY=sk-ant-abc\nFOO=bar');
    expect(loadDotenvFile(p)).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-abc',
      FOO: 'bar',
    });
  });

  it('returns {} for a missing file (no throw)', () => {
    expect(loadDotenvFile(join(root, 'does-not-exist'))).toEqual({});
  });

  it('does NOT mutate process.env', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'AGENT_LOOP_DOTENV_TEST_NEVER_SET=x');
    loadDotenvFile(p);
    expect(process.env['AGENT_LOOP_DOTENV_TEST_NEVER_SET']).toBeUndefined();
  });
});
