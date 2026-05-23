/**
 * runCommand: a thin execa wrapper that returns structured results and
 * optionally logs via the core Logger.
 *
 * Contract:
 * - Never throws on a non-zero exit code (`reject: false` under the hood).
 * - Timeouts: returns with `timedOut: true` and the partial output captured
 *   so far. exitCode is -1 because the process didn't exit normally.
 * - Spawn failures (ENOENT, EACCES): returns with exitCode -1 and an
 *   explanatory message on stderr. We don't throw — callers always inspect
 *   exit codes anyway, and treating "couldn't spawn" as just another failure
 *   keeps the consumer side simple. The `failed` flag distinguishes it from
 *   a normal non-zero exit.
 * - AbortSignal-induced cancellation propagates as an exception. The caller
 *   asked for cancellation; the failed promise is the signal.
 */

import { execa, type Options, type ResultPromise } from 'execa';
import type { Logger } from '@agent-loop/core';

export interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Milliseconds before the process is killed and `timedOut: true` returned. */
  timeoutMs?: number;
  /** Optional logger; logs `cmd start` and `cmd end` records when set. */
  logger?: Logger;
  /** Cancellation. Forwarded to execa's `cancelSignal`. */
  signal?: AbortSignal;
  /** Optional string written to stdin. */
  stdin?: string;
}

export interface RunCommandResult {
  command: string;
  args: string[];
  /** -1 when timedOut or when the process could not be spawned. */
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** True if the process couldn't be spawned (ENOENT etc). */
  spawnFailed: boolean;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const log = options.logger;
  const start = Date.now();
  log?.debug('cmd start', { command, args, cwd: options.cwd });

  // execa's Options has readonly fields, so build it in one expression
  // via conditional spread. exactOptionalPropertyTypes means `undefined`
  // is not interchangeable with "not present".
  const execaOpts: Options = {
    reject: false,
    stripFinalNewline: false,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    ...(options.stdin !== undefined ? { input: options.stdin } : {}),
  };

  let subprocess: ResultPromise | undefined;
  try {
    subprocess = execa(command, args, execaOpts);
    const result = await subprocess;
    const durationMs = Date.now() - start;

    // execa with reject:false returns a result for ALL failure modes,
    // including spawn errors. Tell them apart: a spawn failure has
    // exitCode === undefined and timedOut !== true.
    const timedOut = result.timedOut === true;
    const spawnFailed =
      !timedOut && (result.exitCode === undefined || result.exitCode === null);

    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    let stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (spawnFailed && stderr === '' && 'shortMessage' in result) {
      stderr = String(result.shortMessage);
    }

    const out: RunCommandResult = {
      command,
      args,
      exitCode: result.exitCode ?? -1,
      stdout,
      stderr,
      durationMs,
      timedOut,
      spawnFailed,
    };

    if (timedOut) {
      log?.warn('cmd timeout', { command, durationMs });
    } else if (spawnFailed) {
      log?.error('cmd spawn failed', { command, stderr: out.stderr });
    } else {
      log?.debug('cmd end', {
        command,
        exitCode: out.exitCode,
        durationMs,
      });
    }
    return out;
  } catch (err) {
    const durationMs = Date.now() - start;
    // Belt-and-suspenders: if execa does throw (e.g., AbortSignal aborts),
    // surface it. The timedOut-via-throw path is preserved here in case
    // execa's behavior shifts in a future version.
    const e = err as { timedOut?: boolean; stdout?: string; stderr?: string };
    if (e?.timedOut === true) {
      log?.warn('cmd timeout (thrown)', { command, durationMs });
      return {
        command,
        args,
        exitCode: -1,
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' ? e.stderr : '',
        durationMs,
        timedOut: true,
        spawnFailed: false,
      };
    }
    log?.error('cmd aborted or unexpected error', {
      command,
      err: String(err),
    });
    throw err;
  }
}
