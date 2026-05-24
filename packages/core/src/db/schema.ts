/**
 * SQLite schema.
 *
 * Migrations are an ordered array of SQL strings. The runtime applies them
 * in order, tracking the last-applied index in a `_migrations` table.
 *
 * Rules:
 * - NEVER edit an existing migration. Add a new one.
 * - Each migration must be idempotent or guarded (CREATE TABLE IF NOT EXISTS etc).
 * - Schema lives in core because it's data, not I/O.
 *
 * Why SQLite: single file, no daemon, perfect for local-first tools. We can
 * always swap for Postgres later — the schema is portable.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: 'initial',
    sql: `
      -- Runs are the unit of work. One row per task being processed.
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        artifact_dir  TEXT NOT NULL,
        branch        TEXT NOT NULL,
        phase         TEXT NOT NULL,
        spec_id       TEXT,
        version       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        tokens_spent  INTEGER NOT NULL DEFAULT 0,
        seconds_spent INTEGER NOT NULL DEFAULT 0,
        failure_json  TEXT,
        abandoned_reason TEXT
      );

      -- Index for the orchestrator's main poll query: "next non-terminal run".
      CREATE INDEX IF NOT EXISTS idx_runs_phase ON runs(phase);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

      -- Append-only log of every event applied. This is the audit trail.
      -- We can rebuild any Run by replaying its events from this table.
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload    TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        run_version_after INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);

      -- Specs are immutable once created.
      CREATE TABLE IF NOT EXISTS specs (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL UNIQUE,
        title                 TEXT NOT NULL,
        description           TEXT NOT NULL,
        file_scope_json       TEXT NOT NULL,
        acceptance_json       TEXT NOT NULL,
        test_commands_json    TEXT NOT NULL,
        budget_json           TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );

      -- Migration tracking.
      CREATE TABLE IF NOT EXISTS _migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'plans_and_verdicts',
    sql: `
      -- Plans: one per run. The Plan type has no own id; run_id is the PK.
      -- Re-planning is modeled as a new run, not a second plan row.
      CREATE TABLE IF NOT EXISTS plans (
        run_id              TEXT PRIMARY KEY,
        spec_id             TEXT NOT NULL,
        files_to_touch_json TEXT NOT NULL,
        approach            TEXT NOT NULL,
        risks_json          TEXT NOT NULL,
        test_strategy       TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id),
        FOREIGN KEY (spec_id) REFERENCES specs(id)
      );

      -- Verdicts: append-only. Verifier may produce multiple rows per run
      -- once verification_failed -> executing retries land in week 3.
      -- The Verdict type has no own id; an internal autoincrement preserves
      -- order without leaking into the domain type.
      CREATE TABLE IF NOT EXISTS verdicts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id              TEXT NOT NULL,
        pass                INTEGER NOT NULL,
        test_results_json   TEXT NOT NULL,
        semantic_check_json TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_verdicts_run ON verdicts(run_id, id);
    `,
  },
  {
    id: 3,
    name: 'runs_pr_url',
    sql: `
      -- The PR URL is set when the run reaches phase=done. Stored on the
      -- run row (rather than only in the event payload) so that
      -- agent-loop inspect/list can show it without re-reading the event log.
      -- Nullable: pre-existing rows and runs that never opened a PR have no URL.
      ALTER TABLE runs ADD COLUMN pr_url TEXT;
    `,
  },
  {
    id: 4,
    name: 'tasks',
    sql: `
      -- A Task is a unit of inbound work from a TaskSource (GitHub issue,
      -- local file, eval fixture, etc.). One Task -> one Run. Run.task_id
      -- references this table.
      --
      -- The id is a structured string with a source prefix; today the
      -- only producers are the GitHub source ("github:owner/repo#42"),
      -- the eval runner ("eval:<name>"), and the hardcoded path
      -- ("local:hardcoded"). The parsing surface is small.
      --
      -- source_metadata_json is forward-compat: GitHub will store labels
      -- and assignees here without requiring a future migration. Each
      -- source defines its own shape; the column type stays TEXT (JSON
      -- blob) so we don't have to know upfront.
      CREATE TABLE IF NOT EXISTS tasks (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        body                 TEXT NOT NULL,
        source               TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        url                  TEXT,
        source_metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
    `,
  },
  {
    id: 5,
    name: 'verdicts_calibration_anchor',
    sql: `
      -- Calibration anchor: side-channel comparison between the old shell
      -- testCommands and the new semantic verifier. Set only during eval
      -- runs with --calibration-mode; production runs leave this NULL.
      -- Tracks the gap-calibration-anchor-removal removal gate (the field
      -- + the calibrationTestCommands fixtures get deleted together when
      -- the eval suite shows 0/M disagreements).
      ALTER TABLE verdicts ADD COLUMN calibration_anchor_json TEXT;
    `,
  },
];
