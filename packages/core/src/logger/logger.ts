/**
 * Structured logger.
 *
 * Every log line is a JSON object on its own line (JSONL). This is the format
 * that lets us grep, jq, and ship to any log aggregator without parsing tricks.
 *
 * Console output is pretty-printed; file output is raw JSONL. Both come from
 * the same record so they never diverge.
 *
 * Context is propagated via child loggers: `log.child({ runId })` returns
 * a logger that includes runId on every record. This is how we trace a
 * single run across components without threading runId through every call.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogRecord {
  ts: string;
  level: Level;
  msg: string;
  /** Arbitrary structured context. */
  ctx: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Minimum level to emit. Lower-rank records are dropped. */
  level?: Level;
  /** If set, append JSONL records to this file. */
  filePath?: string;
  /** If false, suppress pretty console output. */
  console?: boolean;
  /** Initial context merged into every record. */
  baseContext?: Record<string, unknown>;
  /** Clock override for testing. */
  now?: () => string;
}

export class Logger {
  private readonly level: Level;
  private readonly filePath: string | undefined;
  private readonly console: boolean;
  private readonly baseContext: Record<string, unknown>;
  private readonly now: () => string;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.filePath = opts.filePath;
    this.console = opts.console ?? true;
    this.baseContext = opts.baseContext ?? {};
    this.now = opts.now ?? (() => new Date().toISOString());

    if (this.filePath) {
      // Ensure parent directory exists. Sync because logger init runs once.
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
  }

  child(extraContext: Record<string, unknown>): Logger {
    return new Logger({
      level: this.level,
      ...(this.filePath !== undefined ? { filePath: this.filePath } : {}),
      console: this.console,
      baseContext: { ...this.baseContext, ...extraContext },
      now: this.now,
    });
  }

  debug(msg: string, ctx: Record<string, unknown> = {}): void {
    this.emit('debug', msg, ctx);
  }
  info(msg: string, ctx: Record<string, unknown> = {}): void {
    this.emit('info', msg, ctx);
  }
  warn(msg: string, ctx: Record<string, unknown> = {}): void {
    this.emit('warn', msg, ctx);
  }
  error(msg: string, ctx: Record<string, unknown> = {}): void {
    this.emit('error', msg, ctx);
  }

  private emit(level: Level, msg: string, ctx: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;

    const record: LogRecord = {
      ts: this.now(),
      level,
      msg,
      ctx: { ...this.baseContext, ...ctx },
    };

    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
      } catch (err) {
        // Logging must never throw. Fall back to stderr.
        process.stderr.write(
          `logger: failed to write to ${this.filePath}: ${String(err)}\n`,
        );
      }
    }

    if (this.console) {
      process.stdout.write(formatPretty(record) + '\n');
    }
  }
}

// --- Pretty formatter ------------------------------------------------------

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

const LEVEL_COLOR: Record<Level, string> = {
  debug: COLORS.gray,
  info: COLORS.blue,
  warn: COLORS.yellow,
  error: COLORS.red,
};

const useColor = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;

export function formatPretty(record: LogRecord): string {
  const time = record.ts.slice(11, 19); // HH:MM:SS
  const lvl = record.level.toUpperCase().padEnd(5);
  const ctxStr = formatContext(record.ctx);

  if (!useColor) {
    return `${time} ${lvl} ${record.msg}${ctxStr}`;
  }

  return (
    `${COLORS.dim}${time}${COLORS.reset} ` +
    `${LEVEL_COLOR[record.level]}${lvl}${COLORS.reset} ` +
    `${record.msg}` +
    (ctxStr ? `${COLORS.dim}${ctxStr}${COLORS.reset}` : '')
  );
}

function formatContext(ctx: Record<string, unknown>): string {
  const keys = Object.keys(ctx);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}=${formatValue(ctx[k])}`);
  return ' ' + parts.join(' ');
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') {
    // Quote if it contains spaces.
    return /\s/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
