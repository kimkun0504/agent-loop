/**
 * Artifact writers — file-on-disk records that complement the SQLite
 * audit trail. The events table is the source of truth for state; the
 * artifacts directory is the source of truth for the *content* of what
 * the agent did (full transcripts, per-command outputs).
 *
 * Layout under `<artifactsDir>/<runId>/`:
 *
 *   executor.log         raw agent stdout+stderr (grep-friendly)
 *   executor.json        ExecutorResult metadata: ok, exit, duration, usage
 *   verdict-NNN.json     full Verdict (one per attempt; zero-padded)
 *   verdict-NNN.log      per-test-command output, concatenated with markers
 *   meta.json            terminal-state snapshot of the Run + Spec summary
 *
 * Every JSON file carries `schemaVersion: 1`. Bumping that field is the
 * signal to readers that a shape change happened — adding it now while
 * the cost is trivial; adding it later when consumers exist is painful.
 *
 * Plans (week 3) will land as `plan.json` in this same directory.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, Spec, Verdict, Failure, Plan } from '@agent-loop/core';
import type { ExecutorResult } from '../executor/types.js';
import type { PlannerResult } from '../agents/plannerSchema.js';
import type { TriageResult } from '../agents/triageSchema.js';
import type { SemanticDebug } from '../verifier/semanticSchema.js';

export const ARTIFACT_SCHEMA_VERSION = 1;

// --- Executor --------------------------------------------------------------

export interface ExecutorArtifactJson {
  schemaVersion: 1;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  spawnFailed: boolean;
  usage?: ExecutorResult['usage'];
}

/**
 * Write `executor.log` (raw output) and `executor.json` (structured
 * metadata) for the agent run. Called regardless of executor success —
 * failed runs are the ones we most want logs from.
 */
export function writeExecutorArtifacts(
  runArtifactDir: string,
  result: ExecutorResult,
): void {
  mkdirSync(runArtifactDir, { recursive: true });
  writeFileSync(join(runArtifactDir, 'executor.log'), result.outputLog);

  const summary: ExecutorArtifactJson = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    spawnFailed: result.spawnFailed,
  };
  if (result.usage) summary.usage = result.usage;
  writeFileSync(
    join(runArtifactDir, 'executor.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
}

// --- Verdict ---------------------------------------------------------------

export interface VerdictArtifactJson {
  schemaVersion: 1;
  verdict: Verdict;
}

const VERDICT_INDEX_WIDTH = 3;

// --- Semantic verifier debug ----------------------------------------------

export interface SemanticDebugArtifactJson {
  schemaVersion: 1;
  debug: SemanticDebug;
}

/**
 * Write `verdict-NNN.semantic-debug.json` capturing the raw model output(s)
 * from the semantic verifier when at least one call failed validation.
 *
 * Called by the orchestrator when the verifier returns a non-undefined
 * debug payload. Closes BACKLOG#polish-semantic-verifier-raw-output-capture
 * (the original CP3 re-run discovered the gap and we had no way to
 * distinguish "model produced an object keyed by criterion" from
 * "model produced a wrapped array" from "response was truncated").
 */
export function writeSemanticDebugArtifact(
  runArtifactDir: string,
  debug: SemanticDebug,
  index: number,
): void {
  mkdirSync(runArtifactDir, { recursive: true });
  const padded = String(index).padStart(VERDICT_INDEX_WIDTH, '0');
  const json: SemanticDebugArtifactJson = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    debug,
  };
  writeFileSync(
    join(runArtifactDir, `verdict-${padded}.semantic-debug.json`),
    JSON.stringify(json, null, 2) + '\n',
  );
}

/**
 * Write `verdict-NNN.json` (full Verdict object) and `verdict-NNN.log`
 * (per-command output with markers). `index` is 1-based; the caller
 * passes the position in the run's verdict sequence.
 */
export function writeVerdictArtifact(
  runArtifactDir: string,
  verdict: Verdict,
  index: number,
): void {
  mkdirSync(runArtifactDir, { recursive: true });
  const padded = String(index).padStart(VERDICT_INDEX_WIDTH, '0');

  const json: VerdictArtifactJson = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    verdict,
  };
  writeFileSync(
    join(runArtifactDir, `verdict-${padded}.json`),
    JSON.stringify(json, null, 2) + '\n',
  );

  const logParts: string[] = [];
  for (const tr of verdict.testResults) {
    logParts.push(
      `$ ${tr.command}\n` +
        `exit ${tr.exitCode}, ${tr.durationMs}ms\n` +
        `--- output ---\n` +
        tr.outputSummary +
        '\n' +
        '='.repeat(60) +
        '\n',
    );
  }
  writeFileSync(
    join(runArtifactDir, `verdict-${padded}.log`),
    logParts.join('\n'),
  );
}

// --- Meta ------------------------------------------------------------------

export interface MetaArtifactJson {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  branch: string;
  phase: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  artifactDir: string;
  attemptCount: number;
  tokensSpent: number;
  secondsSpent: number;
  prUrl?: string;
  failure?: Failure;
  abandonedReason?: string;
  spec?: {
    id: string;
    title: string;
    testCommands: string[];
  };
  latestVerdict?: {
    pass: boolean;
    testCount: number;
    createdAt: string;
  };
}

/**
 * Write the terminal-state snapshot. The spec and latestVerdict are
 * minimal summaries — the full versions remain in the DB and in
 * verdict-NNN.json. The summary is what a human cat'ing meta.json wants.
 */
export function writeMetaArtifact(
  runArtifactDir: string,
  run: Run,
  spec?: Spec,
  latestVerdict?: Verdict,
): void {
  mkdirSync(runArtifactDir, { recursive: true });
  const meta: MetaArtifactJson = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    runId: run.id,
    taskId: run.taskId,
    branch: run.branch,
    phase: run.phase,
    version: run.version,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactDir: run.artifactDir,
    attemptCount: run.attemptCount,
    tokensSpent: run.tokensSpent,
    secondsSpent: run.secondsSpent,
  };
  if (run.prUrl !== undefined) meta.prUrl = run.prUrl;
  if (run.failure !== undefined) meta.failure = run.failure;
  if (run.abandonedReason !== undefined) meta.abandonedReason = run.abandonedReason;
  if (spec) {
    meta.spec = {
      id: spec.id,
      title: spec.title,
      testCommands: spec.testCommands,
    };
  }
  if (latestVerdict) {
    meta.latestVerdict = {
      pass: latestVerdict.pass,
      testCount: latestVerdict.testResults.length,
      createdAt: latestVerdict.createdAt,
    };
  }
  writeFileSync(
    join(runArtifactDir, 'meta.json'),
    JSON.stringify(meta, null, 2) + '\n',
  );
}

// --- Triage --------------------------------------------------------------

export interface TriageArtifactJson {
  schemaVersion: 1;
  result: TriageResult;
  durationMs: number;
}

export function writeTriageArtifact(
  runArtifactDir: string,
  result: TriageResult,
  durationMs: number,
): void {
  mkdirSync(runArtifactDir, { recursive: true });
  const json: TriageArtifactJson = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    result,
    durationMs,
  };
  writeFileSync(
    join(runArtifactDir, 'triage.json'),
    JSON.stringify(json, null, 2) + '\n',
  );
}

// --- Planner -------------------------------------------------------------

export interface PlannerArtifactJson {
  schemaVersion: 1;
  result: PlannerResult;
  durationMs: number;
}

export function writePlannerArtifact(
  runArtifactDir: string,
  result: PlannerResult,
  durationMs: number,
): void {
  mkdirSync(runArtifactDir, { recursive: true });
  const json: PlannerArtifactJson = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    result,
    durationMs,
  };
  writeFileSync(
    join(runArtifactDir, 'planner.json'),
    JSON.stringify(json, null, 2) + '\n',
  );
}

// --- Plan ----------------------------------------------------------------

export interface PlanArtifactJson {
  schemaVersion: 1;
  plan: Plan;
}

/**
 * Mirror of the `plans` table row, written to disk for human inspection
 * and for the CHECKPOINT 3 instrumentation that scans planner outputs.
 * Only written when the planner succeeded (otherwise there's no plan to
 * persist; the rejection is captured in planner.json).
 */
export function writePlanArtifact(
  runArtifactDir: string,
  plan: Plan,
): void {
  mkdirSync(runArtifactDir, { recursive: true });
  const json: PlanArtifactJson = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    plan,
  };
  writeFileSync(
    join(runArtifactDir, 'plan.json'),
    JSON.stringify(json, null, 2) + '\n',
  );
}
