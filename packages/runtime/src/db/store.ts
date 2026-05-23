/**
 * Store: typed wrapper around the SQLite handle.
 *
 * Design rules (see plan v2):
 * - Each public method maps 1:1 to a single SQL statement. No method does
 *   multiple writes. If a caller needs atomicity across primitives, it opens
 *   a transaction with `store.transaction(...)`.
 * - `updateRunByVersion` returns `false` on a version mismatch — that's an
 *   expected outcome (concurrent loop tick), not an exception.
 * - `insertEvent` is callable but **must not be invoked directly to record a
 *   Run state change**. That path is owned by `applyEvent` in
 *   `orchestrator/apply.ts`, which composes the read/transition/write
 *   inside a single transaction with the version guard. Direct
 *   `insertEvent` bypasses the version guard and corrupts the audit trail.
 */

import type Database from 'better-sqlite3';
import {
  type Run,
  type RunId,
  type Spec,
  type SpecId,
  type Plan,
  type Verdict,
  type Phase,
  type Event,
} from '@agent-loop/core';
import {
  rowToRun,
  runToParams,
  rowToSpec,
  specToParams,
  rowToPlan,
  planToParams,
  rowToVerdict,
  verdictToParams,
  rowToEventRecord,
  eventToParams,
  type RunRow,
  type SpecRow,
  type PlanRow,
  type VerdictRow,
  type EventRow,
  type EventRecord,
} from './rows.js';

export class Store {
  readonly db: Database.Database;

  // Cached prepared statements for hot paths. Built once at construction.
  private readonly stmts: {
    getRun: Database.Statement;
    insertRun: Database.Statement;
    updateRunByVersion: Database.Statement;
    listAllRuns: Database.Statement;
    getSpec: Database.Statement;
    getSpecByRun: Database.Statement;
    insertSpec: Database.Statement;
    getPlanByRun: Database.Statement;
    insertPlan: Database.Statement;
    listVerdicts: Database.Statement;
    insertVerdict: Database.Statement;
    listEvents: Database.Statement;
    insertEvent: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = {
      getRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
      insertRun: db.prepare(
        `INSERT INTO runs
          (id, task_id, artifact_dir, branch, phase, spec_id, version,
           created_at, updated_at, attempt_count, tokens_spent, seconds_spent,
           failure_json, abandoned_reason)
         VALUES
          (@id, @task_id, @artifact_dir, @branch, @phase, @spec_id, @version,
           @created_at, @updated_at, @attempt_count, @tokens_spent, @seconds_spent,
           @failure_json, @abandoned_reason)`,
      ),
      updateRunByVersion: db.prepare(
        `UPDATE runs SET
           task_id = @task_id,
           artifact_dir = @artifact_dir,
           branch = @branch,
           phase = @phase,
           spec_id = @spec_id,
           version = @version,
           created_at = @created_at,
           updated_at = @updated_at,
           attempt_count = @attempt_count,
           tokens_spent = @tokens_spent,
           seconds_spent = @seconds_spent,
           failure_json = @failure_json,
           abandoned_reason = @abandoned_reason
         WHERE id = @id AND version = @expected_version`,
      ),
      listAllRuns: db.prepare(
        'SELECT * FROM runs ORDER BY created_at, id',
      ),
      getSpec: db.prepare('SELECT * FROM specs WHERE id = ?'),
      getSpecByRun: db.prepare('SELECT * FROM specs WHERE run_id = ?'),
      insertSpec: db.prepare(
        `INSERT INTO specs
          (id, run_id, title, description, file_scope_json,
           acceptance_json, test_commands_json, budget_json, created_at)
         VALUES
          (@id, @run_id, @title, @description, @file_scope_json,
           @acceptance_json, @test_commands_json, @budget_json, @created_at)`,
      ),
      getPlanByRun: db.prepare('SELECT * FROM plans WHERE run_id = ?'),
      insertPlan: db.prepare(
        `INSERT INTO plans
          (run_id, spec_id, files_to_touch_json, approach,
           risks_json, test_strategy, created_at)
         VALUES
          (@run_id, @spec_id, @files_to_touch_json, @approach,
           @risks_json, @test_strategy, @created_at)`,
      ),
      listVerdicts: db.prepare(
        'SELECT * FROM verdicts WHERE run_id = ? ORDER BY id',
      ),
      insertVerdict: db.prepare(
        `INSERT INTO verdicts
          (run_id, pass, test_results_json, semantic_check_json, created_at)
         VALUES
          (@run_id, @pass, @test_results_json, @semantic_check_json, @created_at)`,
      ),
      listEvents: db.prepare(
        'SELECT * FROM events WHERE run_id = ? ORDER BY id',
      ),
      insertEvent: db.prepare(
        `INSERT INTO events
          (run_id, event_type, payload, applied_at, run_version_after)
         VALUES
          (@run_id, @event_type, @payload, @applied_at, @run_version_after)`,
      ),
    };
  }

  // --- Runs ----------------------------------------------------------------

  getRun(id: RunId): Run | undefined {
    const row = this.stmts.getRun.get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  /**
   * If `filter.phase` is omitted, returns all runs. If it's an empty array,
   * returns []. Otherwise filters by IN (...).
   */
  listRuns(filter?: { phase?: Phase | Phase[] }): Run[] {
    if (filter?.phase === undefined) {
      const rows = this.stmts.listAllRuns.all() as RunRow[];
      return rows.map(rowToRun);
    }
    const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase];
    if (phases.length === 0) return [];
    const placeholders = phases.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE phase IN (${placeholders}) ORDER BY created_at, id`,
      )
      .all(...phases) as RunRow[];
    return rows.map(rowToRun);
  }

  insertRun(run: Run): void {
    this.stmts.insertRun.run(runToParams(run));
  }

  /**
   * Updates a run only if the on-disk version matches `expectedVersion`.
   * Returns true if the row changed, false if it didn't (version mismatch
   * or row missing). Callers — namely `applyEvent` — react to false by
   * throwing a typed error; the Store itself stays mechanism-only.
   */
  updateRunByVersion(run: Run, expectedVersion: number): boolean {
    const params = { ...runToParams(run), expected_version: expectedVersion };
    const info = this.stmts.updateRunByVersion.run(params);
    return info.changes === 1;
  }

  // --- Specs ---------------------------------------------------------------

  getSpec(id: SpecId): Spec | undefined {
    const row = this.stmts.getSpec.get(id) as SpecRow | undefined;
    return row ? rowToSpec(row) : undefined;
  }

  getSpecByRun(runId: RunId): Spec | undefined {
    const row = this.stmts.getSpecByRun.get(runId) as SpecRow | undefined;
    return row ? rowToSpec(row) : undefined;
  }

  insertSpec(spec: Spec): void {
    this.stmts.insertSpec.run(specToParams(spec));
  }

  // --- Plans ---------------------------------------------------------------

  getPlanByRun(runId: RunId): Plan | undefined {
    const row = this.stmts.getPlanByRun.get(runId) as PlanRow | undefined;
    return row ? rowToPlan(row) : undefined;
  }

  insertPlan(plan: Plan): void {
    this.stmts.insertPlan.run(planToParams(plan));
  }

  // --- Verdicts ------------------------------------------------------------

  listVerdicts(runId: RunId): Verdict[] {
    const rows = this.stmts.listVerdicts.all(runId) as VerdictRow[];
    return rows.map(rowToVerdict);
  }

  insertVerdict(verdict: Verdict): void {
    this.stmts.insertVerdict.run(verdictToParams(verdict));
  }

  // --- Events --------------------------------------------------------------

  listEvents(runId: RunId): EventRecord[] {
    const rows = this.stmts.listEvents.all(runId) as EventRow[];
    return rows.map(rowToEventRecord);
  }

  /**
   * @internal-orchestrator
   * Direct callers must not use this to record a Run state change.
   * `orchestrator/apply.ts::applyEvent` is the only sanctioned path; it
   * composes the read/transition/write under one transaction with the
   * version guard. Bypassing it breaks the audit trail.
   */
  insertEvent(
    runId: RunId,
    event: Event,
    runVersionAfter: number,
    appliedAt: string,
  ): void {
    this.stmts.insertEvent.run(
      eventToParams(runId, event, runVersionAfter, appliedAt),
    );
  }

  // --- Transaction control -------------------------------------------------

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
