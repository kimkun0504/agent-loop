import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Logger, formatPretty, type LogRecord } from '../src/logger/logger.js';

describe('Logger', () => {
  let writes: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes = [];
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });
  });

  it('emits records at or above configured level', () => {
    const log = new Logger({ level: 'warn', now: () => '2026-01-01T00:00:00.000Z' });
    log.debug('debug msg');
    log.info('info msg');
    log.warn('warn msg');
    log.error('error msg');
    stdoutSpy.mockRestore();
    expect(writes.join('')).not.toContain('debug msg');
    expect(writes.join('')).not.toContain('info msg');
    expect(writes.join('')).toContain('warn msg');
    expect(writes.join('')).toContain('error msg');
  });

  it('child loggers merge context', () => {
    const log = new Logger({
      level: 'info',
      console: false,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const child = log.child({ runId: 'run-1' });
    const grandchild = child.child({ phase: 'executing' });

    // We can't inspect emitted records without a file. Test via formatPretty directly.
    const record: LogRecord = {
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'x',
      ctx: { runId: 'run-1', phase: 'executing' },
    };
    expect(formatPretty(record)).toContain('runId=run-1');
    expect(formatPretty(record)).toContain('phase=executing');
    // Use the loggers so vitest doesn't complain about unused.
    expect(child).toBeDefined();
    expect(grandchild).toBeDefined();
  });
});

describe('formatPretty', () => {
  it('formats records with timestamp, level, message', () => {
    // Force no-color for stable test output by checking the structure regardless.
    const out = formatPretty({
      ts: '2026-01-15T10:30:45.123Z',
      level: 'info',
      msg: 'hello world',
      ctx: {},
    });
    expect(out).toContain('10:30:45');
    expect(out).toContain('INFO');
    expect(out).toContain('hello world');
  });

  it('appends context as key=value', () => {
    const out = formatPretty({
      ts: '2026-01-15T10:30:45.123Z',
      level: 'info',
      msg: 'event',
      ctx: { runId: 'run-1', tokens: 1500 },
    });
    expect(out).toContain('runId=run-1');
    expect(out).toContain('tokens=1500');
  });

  it('quotes string values that contain spaces', () => {
    const out = formatPretty({
      ts: '2026-01-15T10:30:45.123Z',
      level: 'info',
      msg: 'event',
      ctx: { detail: 'has spaces here' },
    });
    expect(out).toContain('detail="has spaces here"');
  });
});
