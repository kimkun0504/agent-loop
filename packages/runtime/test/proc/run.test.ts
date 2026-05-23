import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/proc/run.js';
import { Logger } from '@agent-loop/core';

describe('runCommand: basic exit codes', () => {
  it('returns exitCode 0 and captures stdout', async () => {
    const r = await runCommand('bash', ['-c', 'echo hello world']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello world\n');
    expect(r.stderr).toBe('');
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns non-zero exitCode without throwing', async () => {
    const r = await runCommand('bash', ['-c', 'exit 7']);
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    const r = await runCommand('bash', ['-c', 'echo out; echo err >&2']);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
  });

  it('preserves the command and args on the result', async () => {
    const r = await runCommand('bash', ['-c', 'true']);
    expect(r.command).toBe('bash');
    expect(r.args).toEqual(['-c', 'true']);
  });
});

describe('runCommand: cwd and env', () => {
  it('runs in the given cwd', async () => {
    const r = await runCommand('bash', ['-c', 'pwd'], { cwd: '/tmp' });
    // Some platforms symlink /tmp; just check the trailing path component.
    expect(r.stdout.trim().endsWith('/tmp')).toBe(true);
  });

  it('passes env vars through', async () => {
    const r = await runCommand('bash', ['-c', 'echo $AGENT_LOOP_TEST'], {
      env: { ...process.env, AGENT_LOOP_TEST: 'hello-env' } as Record<string, string>,
    });
    expect(r.stdout.trim()).toBe('hello-env');
  });
});

describe('runCommand: stdin', () => {
  it('writes the given string to stdin', async () => {
    const r = await runCommand('cat', [], { stdin: 'piped input' });
    expect(r.stdout).toBe('piped input');
  });
});

describe('runCommand: timeout', () => {
  it('marks timedOut=true when the process exceeds the timeout', async () => {
    const r = await runCommand('bash', ['-c', 'sleep 5'], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    // Should not have waited the full 5 seconds.
    expect(r.durationMs).toBeLessThan(2000);
  });

  it('does not mark timedOut for fast commands within the budget', async () => {
    const r = await runCommand('bash', ['-c', 'echo ok'], { timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });
});

describe('runCommand: spawn failure', () => {
  it('returns spawnFailed=true with exitCode -1 when the command is not found', async () => {
    const r = await runCommand('this-binary-does-not-exist-9999', []);
    expect(r.spawnFailed).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.timedOut).toBe(false);
    // Spawn errors include some message we can surface to the caller.
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});

describe('runCommand: logger integration', () => {
  it('emits start and end log records when a logger is provided', async () => {
    const records: Array<{ level: string; msg: string; ctx: Record<string, unknown> }> = [];
    const fakeNow = (): string => '2026-01-01T00:00:00.000Z';
    const logger = new Logger({
      level: 'debug',
      console: false,
      now: fakeNow,
    });
    // Hook into emit via a child logger that captures records. The Logger
    // class doesn't expose a transport hook, so we monkey-patch debug/warn
    // for the duration of the test.
    const origDebug = logger.debug.bind(logger);
    const origWarn = logger.warn.bind(logger);
    logger.debug = (msg, ctx = {}): void => {
      records.push({ level: 'debug', msg, ctx });
      origDebug(msg, ctx);
    };
    logger.warn = (msg, ctx = {}): void => {
      records.push({ level: 'warn', msg, ctx });
      origWarn(msg, ctx);
    };

    await runCommand('bash', ['-c', 'echo ok'], { logger });
    expect(records.find((r) => r.msg === 'cmd start')).toBeDefined();
    expect(records.find((r) => r.msg === 'cmd end')).toBeDefined();
  });

  it('emits a warn record on timeout', async () => {
    const records: Array<{ level: string; msg: string }> = [];
    const logger = new Logger({ level: 'debug', console: false });
    logger.warn = (msg, _ctx = {}): void => {
      records.push({ level: 'warn', msg });
    };
    await runCommand('bash', ['-c', 'sleep 5'], {
      logger,
      timeoutMs: 100,
    });
    expect(records.some((r) => r.msg.startsWith('cmd timeout'))).toBe(true);
  });
});

describe('runCommand: AbortSignal cancellation', () => {
  it('cancellation aborts the subprocess', async () => {
    const controller = new AbortController();
    const promise = runCommand('bash', ['-c', 'sleep 5'], {
      signal: controller.signal,
    });
    // Cancel after a short delay.
    setTimeout(() => controller.abort(), 50);
    // The exact thrown error type depends on execa; we just need the
    // command to NOT take the full 5 seconds.
    const start = Date.now();
    try {
      await promise;
    } catch {
      // expected — abort surfaces as a thrown error
    }
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
