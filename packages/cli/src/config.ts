/**
 * Filesystem layout used by the CLI:
 *
 *   <home>/
 *     runs.db            SQLite database (single source of truth)
 *     cli.log            append-only JSONL logger output
 *     STOP               absent normally; touch to halt the loop
 *     worktrees/<runId>/worktree
 *     artifacts/<runId>/
 *
 * Resolution priority for `home`:
 *   1. explicit argument (tests)
 *   2. $AGENT_LOOP_HOME env var
 *   3. ~/.agent-loop
 *
 * `home` is also what we pass as `workspaceDir` to the runtime; the STOP
 * check lives directly there (runtime's isStopRequested expects
 * <cwd>/STOP).
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentLoopPaths {
  home: string;
  dbPath: string;
  worktreesDir: string;
  artifactsDir: string;
  cliLogPath: string;
  stopFilePath: string;
}

export function resolvePaths(homeOverride?: string): AgentLoopPaths {
  const home =
    homeOverride ??
    process.env['AGENT_LOOP_HOME'] ??
    join(homedir(), '.agent-loop');
  return {
    home,
    dbPath: join(home, 'runs.db'),
    worktreesDir: join(home, 'worktrees'),
    artifactsDir: join(home, 'artifacts'),
    cliLogPath: join(home, 'cli.log'),
    stopFilePath: join(home, 'STOP'),
  };
}

/**
 * Idempotent. Safe to call at the top of every command.
 */
export function ensureAgentLoopDirs(paths: AgentLoopPaths): void {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
}
