# Week 3 plan — eval harness, triage, planner, GitHub Issues

Status: proposed (not yet started). Locked decisions are listed at the top of the kickoff brief; this document designs against them and does not relitigate.

Order of work: **eval scaffold → triage → planner → GitHub Issues**. Each piece grows the eval set and gets measured against the previous baseline.

---

## Section A — Eval harness design

### A1. Directory layout for `evals/tasks/<name>/`

Each eval task is a self-contained fixture. Contract:

```
evals/tasks/<name>/
  task.md            Issue body — free-form prose, the input to triage
  expected.json      { acceptanceCriteria: string[], testCommands: string[],
                      maxDiffLines?: number }
  base/              Starting state of the target repo (file tree)
    package.json
    src/...
    test/...
```

Notably absent: a pre-initialized `.git/` directory. The eval runner copies `base/` into a fresh tmpdir, runs `git init -b main`, stages everything, and creates one initial commit. This keeps task fixtures editable as plain files (no committed-binary footgun) and ensures every eval run starts from a clean known commit.

**Contract a task must satisfy:**

- `task.md` exists, non-empty.
- `expected.json` exists; `testCommands` is a non-empty array of shell strings.
- `base/` exists with at least one file.
- The starting state must pass any test in `expected.json.testCommands` when the agent has not yet edited anything ONLY when the task is "additive" (e.g., the starting tests pass; the new task is to add behavior + tests). For "fix" / "refactor" / "test-only" tasks, the starting state may have failing tests by design; this is encoded in the task description rather than the structure.

### A2. The 5 specific tasks

Each task targets a node on the skill matrix. Names use the verb-noun shape used elsewhere in the repo. Sizing: each `base/` is 5–15 lines of source code plus a tiny existing test.

| Name                | Skill                              | Approx diff |
|---------------------|------------------------------------|-------------|
| `add-clamp`         | Additive feature                   | +10 −0      |
| `fix-off-by-one`    | Bug fix (incl. updating wrong test)| +3 −3       |
| `extract-helper`    | Refactor without behavior change   | +8 −6       |
| `rename-export`     | Cross-file change                  | +6 −6       |
| `add-edge-case-tests` | Test-only change                 | +15 −0      |

**Task 1 — `add-clamp` (additive feature)**

- Base: `src/math.js` exports `multiply(a, b) => a * b`. One existing test asserts `multiply(2, 3) === 6`.
- `task.md`: "Add a `clamp(value, min, max)` helper to `src/math.js`. It should pin value into the `[min, max]` range — return `min` when value is below, `max` when above, value otherwise. The existing test file `test/math.test.js` tests `multiply`. Add a new test file `test/clamp.test.js` (or add tests to the existing file — your choice) for the new function. Make sure the existing multiply test still passes."
- Acceptance criteria: clamp exists and is exported; behaves correctly for value in/below/above range; existing multiply test still passes.
- testCommands: `["node --test test/*.test.js"]`

**Task 2 — `fix-off-by-one` (bug fix)**

- Base: `src/lastn.js` has `lastN(arr, n)` that incorrectly returns `arr.slice(-n - 1)` (one too many items). `test/lastn.test.js` matches the buggy behavior (assertion: `lastN([1,2,3,4], 2)` deepEquals `[2,3,4]`).
- `task.md`: "`lastN` is returning one too many items when n>0 — it should return exactly n items. The test currently expects the wrong behavior; fix both the function and the test. Also handle the edge cases: `n=0` returns `[]`, `n>arr.length` returns the whole array. Note: in JavaScript, `arr.slice(-n)` does NOT do the right thing when `n=0` (it returns the whole array, because `-0 === 0` and `slice(0)` is everything) — handle that case explicitly."
- Acceptance criteria: `lastN([1,2,3,4], 2)` deepEquals `[3,4]`; `lastN([1,2,3], 0)` deepEquals `[]`; `lastN([1,2,3], 99)` deepEquals `[1,2,3]`; tests pass.
- testCommands: `["node --test test/*.test.js"]`
- Tricky bits: (a) tests the agent's willingness to UPDATE an existing wrong test, not just modify source; (b) the `-0` gotcha is called out explicitly in `task.md` so it tests reading-carefully rather than blind-spot trivia.

**Task 3 — `extract-helper` (refactor without behavior change)**

- Base: `src/validate.js` and `src/normalize.js` both contain a duplicate `isValidUrl(s)` (~5 lines each, identical body). `test/validate.test.js` and `test/normalize.test.js` exist with passing assertions.
- `task.md`: "`isValidUrl` is duplicated in `src/validate.js` and `src/normalize.js`. Extract it into a shared helper (your call where) and have both files use it. Behavior must not change — the existing tests should all still pass without modification."
- Acceptance criteria: tests pass unchanged; test files have NOT been modified.
- testCommands: `["node --test test/*.test.js", "git diff --quiet HEAD~1 -- test/"]`
- The second command is the load-bearing check — it exits 0 only if no test file was touched.

**Task 4 — `rename-export` (cross-file change)**

- Base: `src/date.js` exports `parseDate(s)`; `src/format.js` and `test/format.test.js` both import it.
- `task.md`: "Rename `parseDate` to `parseIsoDate` everywhere it's referenced. It's defined in `src/date.js` and used from at least `src/format.js` and `test/format.test.js`. The function only handles ISO 8601 input and the old name is misleading new contributors."
- Acceptance criteria: tests pass; no `parseDate` token remains in `src/` or `test/`.
- testCommands: `["node --test test/*.test.js", "! grep -rE 'parseDate\\b' src/ test/"]`
- Note: the "at least" wording bounds the work (the agent knows where to start) without restricting it — if future fixture changes add more references, the spec still covers them. Removes "test of grep attention" from the signal; keeps "test of cross-file editing."

**Task 5 — `add-edge-case-tests` (test-only change)**

- Base: `src/parse-int32.js` with a correct `parseInt32(str)` implementation. `test/parse-int32.test.js` has basic tests only (one happy-path case).
- `task.md`: "Our `parseInt32` implementation looks correct but test coverage is thin. Add tests for: negative numbers, leading/trailing whitespace, values at INT32 boundaries (`-2^31`, `2^31-1`), values that overflow Int32, and non-numeric input. Don't modify `src/parse-int32.js` — just add tests."
- Acceptance criteria: tests pass; `src/` has NOT been modified.
- testCommands: `["node --test test/*.test.js", "git diff --quiet HEAD~1 -- src/"]`

### A3. Eval runner

`pnpm eval` (a new top-level script that delegates to a new package script, probably `pnpm --filter @agent-loop/cli eval` under the hood):

1. Discover every directory under `evals/tasks/` containing a valid `task.md` and `expected.json`. Skip invalid ones with a warn (don't fail the whole suite — surface in the report).
2. For each task, **sequentially**:
   a. `mkdtemp` → copy `base/` → `git init -b main` + initial commit.
   b. Drive a fresh agent-loop run: read `task.md`, create a Task row in the eval DB, run through triage → planner → executor → verifier. (Before triage lands, the eval runner converts `task.md` directly to a Spec by hand-rolling — Phase A baseline; Phase D onward uses real triage.)
   c. Wait for terminal phase. Capture per-phase durations, tokens, costs from the events table.
   d. `rm -rf` the tmpdir.
3. Write `evals/results/<timestamp>/summary.json` and (Phase A+) a small `report.md`.
4. Exit 0 if pass rate ≥ QUALITY target (80%); non-zero otherwise. CI-friendly.

**Sequential, not parallel.** 5 tasks × ~5 min each = ~25 min total. Parallel adds shared-DB write contention, parallel-Claude-rate-limit considerations, and a debugging headache. Defer until tasks count is high enough that 25 minutes hurts.

**Pass determination:** `verdict.pass === true` AND `Run.phase === 'done'`. Anything else is a fail.

**Results destination:** `evals/results/<timestamp>/` (timestamp = ISO date-only or unix-seconds), gitignored. `summary.json` and `report.md` are the rollup at the top of that dir. Per-run artifacts (the executor transcript, verdicts, meta) live at `<timestamp>/<task-name>/<runId>/` — the runId nesting matches the runtime's artifact writers (`<artifactsDir>/<runId>/`) so a future `agent-loop inspect --db <evals/runs.db>` works against the same paths. The CHECKPOINT 1 baseline run was the source of this layout correction; the original draft of this plan flattened the runId out, but the code is the source of truth.

### A4. Metrics captured + reported

`summary.json` shape (anchored to QUALITY.md):

```json
{
  "timestamp": "2026-05-23T22:15:00Z",
  "gitHead": "abc1234",
  "totalTasks": 5,
  "passed": 4,
  "passRate": 0.8,
  "perTask": [
    {
      "name": "add-clamp",
      "passed": true,
      "phase": "done",
      "durationMs": 234000,
      "tokensSpent": 12345,
      "costUsd": 0.21,
      "cacheHitRate": 0.85,
      "perPhase": {
        "triaging": { "durationMs": 4200, "tokensSpent": 4000, "costUsd": 0.01 },
        "planning":  { "durationMs": 8000, "tokensSpent": 7000, "costUsd": 0.03 },
        "executing": { "durationMs": 50000, "tokensSpent": 1000, "costUsd": 0.17 },
        "verifying": { "durationMs": 800,  "tokensSpent": 0,    "costUsd": 0 }
      },
      "failure": null
    }
  ],
  "aggregates": {
    "p50DurationMs": ...,
    "p95DurationMs": ...,
    "p50CostUsd": ...,
    "p95CostUsd": ...,
    "p50CacheHitRate": ...,
    "medianCostUsd": ...
  }
}
```

Tie-back to QUALITY.md:

| Metric                                | QUALITY tier | Source field            |
|---------------------------------------|--------------|-------------------------|
| Eval pass rate                        | Tier 1       | `passRate`              |
| p50/p95 task completion time          | Tier 2       | `aggregates.p{50,95}DurationMs` |
| p50 cache hit rate                    | Tier 5 (proposed) | `aggregates.p50CacheHitRate` |
| Median cost per task                  | Tier 5       | `aggregates.medianCostUsd` |
| Zero-token runs (=0%)                 | Tier 1       | assertion: every passed task has tokensSpent > 0 |
| Cost per run is reported (=100%)      | Tier 3       | assertion: tokensSpent present on every run |

### A5. SQLite integration — separate DB

**Recommendation: separate DB at `evals/runs.db`** (gitignored, project-scoped).

Reasons:
- Eval runs are throwaway noise. Mixing them with production runs pollutes `agent-loop list` and `inspect`.
- Eval-specific tooling is the only thing that needs to read them.
- One-line cleanup (`rm evals/runs.db`) when iterating on prompts.

Trade-off: `inspect <runId>` doesn't work for eval runs from the production CLI. Acceptable — eval has its own report.md output anyway. If we later want cross-DB inspect, add `inspect --db <path>` then.

A `kind` column on the production `runs` table was considered and rejected: adds a filter at every list site for marginal benefit.

---

## Section B — Triage agent design

### B1. Interface

```ts
interface TriageInput {
  taskDescription: string;       // raw issue body (prose)
  taskTitle?: string;            // issue title if available
  targetRepoPath: string;
  logger?: Logger;
  signal?: AbortSignal;
}

interface TriageProducedSpec {
  title: string;
  description: string;
  fileScope: string[];
  acceptanceCriteria: string[];
  testCommands: string[];
  // budget injected by the orchestrator from a default policy, NOT
  // produced by the model — we don't trust the model to size limits
}

type TriageResult =
  | { ok: true;  spec: TriageProducedSpec; usage: TokenUsage }
  | { ok: false; reason: TriageRejectionReason; message: string;
      clarifyingQuestions?: string[]; usage?: TokenUsage };

type TriageRejectionReason =
  | 'not_actionable'    // task is a discussion / opinion request
  | 'too_vague'         // can't define acceptance criteria
  | 'out_of_scope'      // task spans many files / is a multi-step initiative
  | 'invalid_output'    // model gave us garbage twice in a row
  | 'sdk_error';        // network / auth / rate limit

async function runTriage(input: TriageInput): Promise<TriageResult>;
```

### B2. Prompt strategy (highest-leverage decision in Week 3)

**System prompt structure:**
- Role: "You are a triage assistant for an autonomous coding agent."
- Job: "Given a free-form task description and a brief view of the target repo, produce a structured Spec that downstream agents will act on."
- Output format: declared via the SDK's structured output (json_schema mode). The schema is the `TriageResult` discriminated union (`ok: true | false`).
- Anti-patterns: list scenarios where the model SHOULD pick the rejection branch:
  - Task asks for design opinion or "what do you think about X"
  - Task spans many files in ways that imply a multi-PR initiative
  - Task is too vague — no concrete success criteria can be inferred
- Examples: 2–3 worked (input → output) pairs. Examples cover: (1) a clean actionable issue → spec, (2) a vague one → too_vague rejection with clarifyingQuestions, (3) an issue that names files explicitly → spec with narrow fileScope.

**Repo context to inject (~10 KB total):**
- File tree (depth-limited, deny-list for `node_modules`, `dist`, `.git`, `.next`, etc.) — first 5KB.
- `README.md` head (first 2 KB).
- `package.json` (first 1 KB).
- `CLAUDE.md` head if present (first 1 KB).

Implementation: a `collectRepoContext(target)` helper in `packages/runtime/src/agents/repoContext.ts`.

**When to ask clarifying questions vs produce a spec:**
- The schema makes this binary: model picks `ok: true` or `ok: false`.
- The model is instructed to lean toward producing a spec for issues that are reasonably specific, and reject (with clarifying questions) only when acceptance criteria cannot be inferred.
- I'd start lenient. If we see junk specs in eval runs, tighten the prompt.

**fileScope when triage doesn't know which files matter:**
- If the task description names files, use them.
- Otherwise, emit a best-guess working set as glob(s) like `src/**/*.js`. The planner refines.
- Discouraged: `**/*` as a catch-all. The system prompt says so explicitly and the planner treats it as a signal that triage was uncertain.

### B3. Output validation

The SDK's json_schema mode guarantees structural shape. But semantically:
- `acceptanceCriteria` could be `[]` (vacuous).
- `testCommands` could be `[]` (verifier auto-passes — bad).
- `fileScope` could be `['**/*']` (no real scope).
- Title could be 500 chars long.

**Validator** (`validateTriageOutput(raw: unknown): TriageProducedSpec | { errors: string[] }`):
- `title` non-empty, ≤200 chars.
- `description` non-empty, ≤10 KB.
- `fileScope` non-empty array of non-empty strings; refuse `['**/*']` and `['**']`.
- `acceptanceCriteria` ≥1 entry, each ≤500 chars.
- `testCommands` ≥1 entry.

**On invalid output:**
1. Log warn with details.
2. Retry ONCE with the feedback inlined ("Your previous output had these issues: …. Try again.").
3. If second attempt also invalid: return `{ ok: false, reason: 'invalid_output', message: '...' }`.

Bounded retry: ≤2 SDK calls per triage. No prompt-injection escalation (we just re-prompt with the validation feedback).

**No Zod dependency.** Hand-rolled validators per CLAUDE.md's "no new framework" disposition. If validation logic balloons, revisit.

### B4. Cost expectation

Haiku 4.5 pricing (approximate, as of writing):
- ~$1 / MTok input
- ~$5 / MTok output
- Cache reads ~$0.10 / MTok

Per-call sizing:
- System prompt: ~3 KB (~1 K tokens)
- Examples: ~2 KB (~0.5 K tokens)
- Repo context: ~10 KB (~3 K tokens)
- Task description: ~2 KB (~0.5 K tokens)
- Output: ~500 tokens

Per-call cost: ~5 K input × $1/M + 500 out × $5/M ≈ **$0.0075**. With prompt caching on the system+repo block, subsequent calls drop to ~$0.0005.

**Where this blows up:**
- Unbounded repo context (huge repos) → enforce a 10 KB cap.
- Long task descriptions (issues with attached logs) → cap at 5 KB; summarize if longer.
- Retry storms → bounded at 1 retry.

### B5. Where the code lives

```
packages/runtime/src/agents/
  triage.ts              runTriage(input) -> TriageResult
  triagePrompt.ts        buildTriageSystemPrompt(), buildTriageUserPrompt(input)
  triageSchema.ts        JSON schema (for SDK) + plain TS types
  triageValidate.ts      hand-rolled validator
  repoContext.ts         collectRepoContext(target) -> ContextSnapshot
```

**Orchestrator hook:** `tickTriaging` in `orchestrator/tick.ts` becomes:

1. Read the Task row (via the new `tasks` table — see Section D).
2. Call `runTriage({ taskDescription, taskTitle, targetRepoPath })`.
3. On `ok: true`: assemble the full `Spec` (inject runId, specId, createdAt, budget from a default policy), `store.insertSpec(spec)`, apply `triage_succeeded` event with the specId.
4. On `ok: false`: apply `triage_failed` event with the failure category mapped from `TriageRejectionReason`. `clarifyingQuestions` are included in the failure message for now (Week 3 lands in `failed` phase; the GitHub-comment-back loop is a deferred polish item, see Section F5).

### B6. Testing strategy

- **Unit tests** (`triage.test.ts`): mock the Anthropic SDK client via injection. Coverage:
  - Happy path: stubbed SDK returns a valid spec → applyEvent path produces `triage_succeeded`.
  - Schema-invalid response: stubbed SDK returns malformed JSON → validator rejects → retry → stubbed SDK on retry returns valid → success.
  - Two consecutive invalids: stubbed SDK returns malformed twice → `TriageRejection` with reason `invalid_output`.
  - Rejection branch: stubbed SDK returns `{ ok: false, reason: 'too_vague', ... }` → mapped to `triage_failed` event.
- **Prompt tests** (`triagePrompt.test.ts`): pure (no SDK). Assert structure — system prompt contains the role line, anti-pattern bullets, examples; user prompt contains repo context blocks and task description.
- **Repo context tests** (`repoContext.test.ts`): tmpdir-based; verify deny-list, depth limit, byte budgets.
- **Integration test** behind `AGENT_LOOP_LIVE_LLM=1`: one task description, real Haiku call, assert the response parses and validates.
- **Eval suite** is the canonical signal for prompt quality. Per-commit eval pass rate is the regression signal.

How to tell when the prompt got better/worse: eval pass rate per commit. We don't have automated A/B yet (out of scope for Week 3). Manual: run the eval suite before and after a prompt change, diff the numbers.

---

## Section C — Planner agent design

### C1. Interface

```ts
interface PlannerInput {
  spec: Spec;
  targetRepoPath: string;
  logger?: Logger;
  signal?: AbortSignal;
}

interface PlannerProducedPlan {
  filesToTouch: PlannedFileChange[];   // { path, action: 'create'|'modify'|'delete', reason }
  approach: string;
  risks: string[];                     // may be empty if no flagged risks
  testStrategy: string;
}

type PlannerResult =
  | { ok: true; plan: PlannerProducedPlan; usage: TokenUsage }
  | { ok: false; reason: 'unimplementable' | 'invalid_output' | 'sdk_error';
      message: string; usage?: TokenUsage };

async function runPlanner(input: PlannerInput): Promise<PlannerResult>;
```

### C2. Prompt strategy

Smaller than triage's. The planner reads a structured spec — already cleaned up by triage. Its job is bounded: read spec + repo, list files it would touch, describe approach, name risks, propose test strategy.

**System prompt:**
- Role: "You are a planner for an autonomous coding agent."
- Job: "Given a Spec and a view of the target repo, produce a Plan: which files to touch, what the approach is, what could go wrong, how to verify."
- Anti-patterns: don't restate the spec; don't propose acceptance criteria (those came from triage); don't propose multi-PR initiatives.
- Output format via SDK json_schema.

**Repo context for planner (~30 KB):**
- Same tree as triage.
- Full file contents of every path matching `spec.fileScope`, capped at 30 KB total. If exceeded, list the files with line counts and call that out in the prompt.

### C3. Output validation

Same retry policy as triage (≤1 retry on invalid output → reject).

Semantic validation:
- `filesToTouch` non-empty.
- Every `PlannedFileChange.action` ∈ `{create, modify, delete}`.
- `approach` non-empty.
- `testStrategy` non-empty.
- `risks` can be empty array.

### C4. Cost expectation

Sonnet 4.6 pricing (approximate):
- ~$3 / MTok input
- ~$15 / MTok output
- Cache reads ~$0.30 / MTok

Per-call:
- Input: ~30 KB ≈ 7.5 K tokens
- Output: ~2 KB ≈ 0.5 K tokens
- Cost: 7.5 K × $3/M + 0.5 K × $15/M ≈ **$0.03**.
- With caching: ~$0.015 (system prompt + repo tree cacheable; file contents change less between calls but more than the tree).

**Where it blows up:**
- Spec has fileScope with many large files → bounded by 30 KB cap.
- Sonnet sometimes elaborates verbosely → cap output at ~2 KB via the schema's max-length hints; failing that, validate and trim.

### C5. Where the code lives

```
packages/runtime/src/agents/
  planner.ts
  plannerPrompt.ts
  plannerSchema.ts
  plannerValidate.ts
```

`tickPlanning` in `orchestrator/tick.ts`:
1. Read Run.specId → `store.getSpec`.
2. Call `runPlanner({ spec, targetRepoPath })`.
3. On `ok: true`: `store.insertPlan(plan)` + apply `planning_succeeded`.
4. On `ok: false`: apply `planning_failed` event with category derived from reason.

### C6. Testing strategy

Same patterns as triage. Mock SDK for units; eval suite for end-to-end; prompt iteration via eval pass rate.

---

## Section D — GitHub Issues task source

### D1. TaskSource interface

The interface should support future implementations (local files, Linear, etc.). We only build the GitHub impl in Week 3.

```ts
interface TaskSource {
  /** Stable id for the source (e.g., "github:owner/repo"). */
  readonly id: string;

  /** Pull up to `limit` tasks that have not yet been picked up. */
  fetchNew(opts?: { limit?: number }): Promise<Task[]>;

  /**
   * Fetch a specific task by id. Returns null if the task doesn't exist
   * or isn't accessible. Used by the `--issue <n>` CLI path so we don't
   * have to filter through `fetchNew` (which is brittle if the label
   * state has changed between when the human ran the CLI and when the
   * orchestrator looks).
   */
  fetchById(taskId: TaskId): Promise<Task | null>;

  /** Acknowledge that a task is being worked. */
  markStarted(taskId: TaskId, runId: RunId): Promise<void>;

  /** Mark a task complete with the PR URL. */
  markDone(taskId: TaskId, runId: RunId, prUrl: string): Promise<void>;

  /** Mark a task failed with a reason. */
  markFailed(taskId: TaskId, runId: RunId, reason: string): Promise<void>;

  /** Mark a task as needs-clarification (triage rejection with questions). */
  markNeedsInfo(taskId: TaskId, runId: RunId, questions: string[]): Promise<void>;
}

interface Task {
  id: TaskId;               // structured prefix: "github:owner/repo#42"
  title: string;
  body: string;
  source: string;           // matches TaskSource.id
  createdAt: string;
  url?: string;             // for backlinking from artifacts
}
```

### D2. GitHub implementation

Module: `packages/runtime/src/sources/github.ts`. Uses `gh` CLI via the existing `runCommand` wrapper (injectable runner pattern, same as GhPrOpener).

**Label conventions:**

| Label             | Meaning                                                     |
|-------------------|-------------------------------------------------------------|
| `agent-ready`     | Issue is eligible for the agent to pick up                  |
| `agent-working`   | Orchestrator picked it up; in-flight                        |
| `agent-done`      | PR opened, run terminal                                     |
| `agent-failed`    | Run failed (triage/planning/executing/verifying/PR-opening) |
| `agent-needs-info`| Triage rejected with clarifying questions                   |

**Operations (all via `gh issue edit` / `gh issue list` / `gh issue comment`):**

| Method          | gh invocation                                                                                                |
|-----------------|--------------------------------------------------------------------------------------------------------------|
| `fetchNew`      | `gh issue list --repo <repo> --label agent-ready --state open --json number,title,body,createdAt,url`        |
| `fetchById`     | `gh issue view <n> --repo <repo> --json number,title,body,createdAt,url,labels` (returns null on exit ≠ 0)   |
| `markStarted`   | `gh issue edit <n> --add-label agent-working --remove-label agent-ready` + `gh issue comment <n>` (unless quiet) |
| `markDone`      | `gh issue edit <n> --add-label agent-done --remove-label agent-working` + comment with PR URL (unless quiet) |
| `markFailed`    | `gh issue edit <n> --add-label agent-failed --remove-label agent-working` + comment with reason (unless quiet) |
| `markNeedsInfo` | `gh issue edit <n> --add-label agent-needs-info --remove-label agent-working` + comment with questions (unless quiet) |

**Constructor option: `{ quiet?: boolean }` (default false).** When `quiet: true`, label transitions still fire; the comment-on-issue calls are suppressed. Useful for high-traffic repos where the per-state comments become noise. CLI exposes via `--quiet` on `agent-loop start --source github`. Real repos will eventually need this; the demo target gets the verbose default to exercise the full audit trail.

State transitions on the GitHub side:

```
opened with [agent-ready]
  -> [agent-working]            (orchestrator picks up)
    -> [agent-done] + PR link   (happy path)
    -> [agent-failed] + reason  (anything goes wrong)
    -> [agent-needs-info] + Qs  (triage rejection with clarifying questions)
```

### D3. Orchestrator discovery

**On-demand, not polling.** Week 3 does NOT introduce a daemon (that's the still-open `polish-daemon-vs-oneshot` entry). On-demand:

```
agent-loop start --source github --repo kimkun0504/agent-loop-target \
  --target ~/projects/agent-loop-target [--issue <n>] [--quiet]
```

Behavior:
1. CLI builds a `GhTaskSource` for the given `--repo` (with `{ quiet: opts.quiet }`).
2. If `--issue <n>` is given: `source.fetchById(...)` — must exist; exit with error if not.
   Otherwise: `source.fetchNew({ limit: 1 })` — picks the oldest open `agent-ready` issue.
3. `source.markStarted(taskId, runId)` adds `agent-working` label (and comment, unless `--quiet`).
4. Creates a Task row + Run row.
5. Runs through triage → planner → executor → verifier → opening_pr → done (same per-tick loop as the existing start command).
6. On terminal: call the appropriate `markDone` / `markFailed` / `markNeedsInfo` based on `Run.phase` + `Run.failure`.
7. Exit.

Flags:
- `--issue <n>` — target a specific issue (via `fetchById`) rather than the oldest agent-ready.
- `--quiet` — suppress GitHub comments; label transitions still happen.

### D4. Task ↔ Run mapping

- `TaskId` is a branded string with structured prefix: `github:owner/repo#42`.
- `tasks` table (migration #4) stores the task. Schema:

  ```sql
  CREATE TABLE IF NOT EXISTS tasks (
    id                   TEXT PRIMARY KEY,
    title                TEXT NOT NULL,
    body                 TEXT NOT NULL,
    source               TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    url                  TEXT,
    source_metadata_json TEXT  -- forward-compat: labels, assignees, etc.
  );
  ```
- `Run.taskId` already exists; in Week 3 it carries the structured id and references a row in `tasks`.
- The agent's PR title is whatever the spec.title comes out as (likely a polished version of the issue title, decided by triage).

### D5. PR linking back to the issue

Approach: **the Run's `taskId` is the link source.** The PR opener resolves it:

1. The PR opener (`GhPrOpener`) gets the Run.
2. Looks up the task: `store.getTask(run.taskId)`.
3. If the task's `source` starts with `github:`, append `Closes #<n>` to the PR body (extract `<n>` from the `taskId` suffix).

This keeps the `Spec` type clean — no `linkedIssue` field needed. The link is metadata about the task source, not part of the spec.

GitHub auto-closes the linked issue when the PR merges. We don't auto-merge (per CLAUDE.md), so the issue stays open until a human merges the PR — at which point it closes automatically.

### D6. What about hardcoded specs?

`agent-loop start --spec <name> --target <path>` keeps working unchanged. It bypasses triage AND the task source. The flow:
1. CLI generates a synthetic Task row (source=`local:hardcoded`).
2. Builds the Spec from the registry.
3. drives via the old `driveToExecuting` helper (which applies triage_succeeded with the registry spec, then plan_approved, etc.).

Actually — once triage and planner exist, even the hardcoded path could go through them on a synthetic task body. But that's pointless: hardcoded specs already define what we want. Keep the bypass: hardcoded specs skip triage AND planner.

CLI flag validation:
- `--spec` and `--source` are mutually exclusive. Validate at parse time, exit 1 with a clear message if both are passed.
- Eval runner uses hardcoded-style (no triage/planner) for the Phase A baseline, and triage-style (no `--spec`, simulating GitHub via a synthetic TaskSource) once that lands.

---

## Section E — API key handling

### E1. Where the loader lives

`packages/runtime/src/config/dotenv.ts`. The runtime is what needs the key — SDK calls happen inside the agent modules in `packages/runtime/src/agents/`.

Two exports:
- `loadDotenv(path: string): Record<string, string>` — pure-ish: reads a file, parses `KEY=value` lines, returns a map. Skips comment lines (`#…`), blank lines, malformed lines (with a warn).
- `loadAnthropicKey(paths: AgentLoopPaths): string | null` — reads `<home>/.env`, returns `ANTHROPIC_API_KEY` or null.

**No new dependency.** A 20-line `KEY=value` parser is enough. The full `dotenv` package has lots of features (variable expansion, multi-line) we don't need.

The CLI is the consumer:
- `cli/commands/start.ts` calls `loadAnthropicKey(paths)` after `ensureAgentLoopDirs`.
- Passes the value into the SDK client factory.

### E2. Tests handle missing key

- **Unit tests**: every agent module accepts an injectable SDK client. Tests pass a fake. No real key needed in `pnpm -r test`.
- **Integration tests behind `AGENT_LOOP_LIVE_LLM=1`**: skip by default in unit-test runs; opt-in for local smoke checks. CI default = skip.
- **Eval suite**: requires the key. Bails with a clear error if missing.

### E3. Startup validation, fail loudly

**Validate at startup.** Reasons:

- Cost of fail-late: user kicks off, waits for git status / worktree setup, sees error 30s in.
- Cost of fail-early: instant feedback.
- The Anthropic API doesn't have a cheap "is this key valid" ping (and "valid" depends on the org's billing state, model entitlements, etc.). We only check **presence**, which is cheap.

Concrete behavior:
- `agent-loop start` (any variant that needs SDK): check key presence at the top.
- Absent → write error to stderr, exit 1.
- Present-but-invalid (e.g., revoked) → first SDK call fails; error propagates as `triage_failed: sdk_error`. Acceptable — that's the same failure mode as a transient network issue.

For Week 3 incremental builds, the gate moves as phases land:
- After Phase B (`.env` + SDK plumbing): key required when launching anything that does SDK calls.
- After Phase D (triage): all production runs need the key (since triage is in the path). Hardcoded specs still skip both triage and planner — they DON'T need a key. Document this asymmetry.
- After Phase E (planner): hardcoded specs still skip planner (per the bypass). They still don't need a key.

(So the bypass for hardcoded specs continues to work without an API key. Useful for offline testing of executor changes.)

### E4. Error message

```
agent-loop: ANTHROPIC_API_KEY not found.

Set it in ~/.agent-loop/.env:

    ANTHROPIC_API_KEY=sk-ant-...

Get a key at https://console.anthropic.com/settings/keys.
```

Concrete file path, copy-pasteable line, link to source. No vague "configure your environment."

---

## Section F — Cross-cutting concerns

### F1. Cost accumulation across phases

Currently `tickExecuting` records tokens and runs the budget check. With triage and planner, two more phases produce token usage.

**Refactor:** extract a helper in `orchestrator/tick.ts`:

```ts
function recordPhaseUsageAndCheckBudget(
  deps: Deps,
  runId: RunId,
  spec: Spec,
  result: { usage?: TokenUsage; durationMs: number },
  currentPhaseFailEvent: (failure: Omit<Failure, 'phase'>) => Event,
): Run | null   // returns null if NOT over budget; returns the failed Run otherwise
```

Each phase handler (`tickTriaging`, `tickPlanning`, `tickExecuting`) calls it after the agent call returns. If the helper returns a non-null Run (budget exceeded), the handler short-circuits — the run is in a terminal failed phase, no further work.

The phase-specific failure event is passed in by the caller so the helper doesn't need to know which phase it's in.

### F2. Artifacts directory additions

Current layout (Polish Sprint):
```
executor.log, executor.json, verdict-NNN.{json,log}, meta.json
```

Add (Week 3):
```
triage.json        { schemaVersion: 1, input: { taskDescription, taskTitle, repoContextDigest },
                     output: TriageResult, usage, durationMs }
triage.log         raw model response text (debugging aid)
planner.json       { schemaVersion: 1, input: { spec, repoContextDigest },
                     output: PlannerResult, usage, durationMs }
planner.log        raw model response
plan.json          { schemaVersion: 1, plan }  -- the approved plan; mirrors the plans table row
```

New writers in `packages/runtime/src/artifacts/write.ts`:
- `writeTriageArtifact(dir, input, output, usage, durationMs)`
- `writePlannerArtifact(dir, input, output, usage, durationMs)`
- `writePlanArtifact(dir, plan)`

All carry `schemaVersion: 1` (the field that lets future readers detect shape changes).

`repoContextDigest` is a sha256 of the repo context block — lets us tell when the prompt's repo view changed without bloating the artifact with the full 10 KB+ context. The full context lives only in the prompt log (debug only, off by default in production).

### F3. Event log additions

No new event types needed. Existing taxonomy covers Week 3:

- `triage_succeeded { specId }` — already exists.
- `triage_failed { failure }` — already exists.
- `planning_succeeded` — already exists.
- `planning_failed { failure }` — already exists.
- `record_token_usage { tokens, usage? }` — already extended in Polish Sprint; reused by triage + planner.
- `record_time_spent { seconds }` — already exists; reused.
- `increment_attempt` — fired by the SDK-output retry path inside agent modules.

The validator-retry pattern uses `increment_attempt` to record that we re-prompted the model. Caps at attempts ≤ 2 (one initial + one retry). The spec.budget.maxAttemptsPerPhase (currently 3) governs this implicitly.

**Critical: `record_token_usage` for the failed call is applied BEFORE the retry begins.** Without this rule, a malformed-output retry storm could spend N×budget worth of tokens while the orchestrator only sees the cost of the final successful call — a real hole in budget enforcement. The exact sequence inside an agent module:

1. SDK call 1 → invalid output → validator rejects.
2. **Apply `record_token_usage` for call 1's tokens.** The call still cost real money.
3. Apply `increment_attempt`.
4. SDK call 2 with validator feedback prepended → valid (in the common case) → return.
5. Caller applies `record_token_usage` for call 2 via the normal post-call flow.

If call 2 also fails validation, the agent returns a `TriageRejection { reason: 'invalid_output' }` (or planner equivalent) — but only after applying call 2's `record_token_usage` too. The tick-layer budget check sees the cumulative cost, and a retry storm trips `budget_exceeded` correctly.

### F4. CLAUDE.md additions

New bullets to land in CLAUDE.md as part of Week 3:

Under **Hard rules**:
- **API keys live in `~/.agent-loop/.env`.** Never commit `.env` files. Never read from arbitrary env vars in code — always go through `loadAnthropicKey()` in `packages/runtime/src/config/dotenv.ts`.
- **SDK calls go through the agent modules in `packages/runtime/src/agents/`.** Don't `import` from `@anthropic-ai/sdk` anywhere else. Other code receives an SDK client by dependency injection.

Under a new section, **Eval suite**:
- `pnpm eval` runs the eval set. New task = new directory under `evals/tasks/<name>/` with `task.md`, `expected.json`, and `base/`.
- Eval results land in `evals/results/<timestamp>/`. Gitignored.
- Eval runs use `evals/runs.db` (separate from `~/.agent-loop/runs.db`).

Under **What not to do**:
- Don't bypass the SDK client factory to hit the Anthropic API directly. The factory is what tests intercept.

### F5. BACKLOG entries to defer (≥ 3)

Things explicitly punted out of Week 3 scope, to land as P2/P3 entries when the sprint closes:

1. **`polish-triage-clarifying-questions-feedback-loop`** (P2). When triage rejects with clarifying questions, Week 3 just lands in `failed`. Eventually: post questions as a comment on the GitHub issue (label `agent-needs-info`), and on re-add of `agent-ready` (after a human edits the body), re-trigger triage with the updated context. Closes the loop between agent and human.

2. **`polish-eval-suite-parallelism`** (P3). Eval runs sequentially. Worth parallelizing once the task set is large enough that 25+ minutes hurts. Wait until ≥10 tasks.

3. **`polish-structured-output-streaming`** (P3). Use `--output-format stream-json` (Claude Code CLI) or streaming SDK responses for triage/planner. Enables real-time progress in a future TUI/web UI; lets us short-circuit on early validation failures. Defer until there's a UI consumer.

4. **`polish-prompt-cache-key-control`** (P1). Default prompt caching is content-hash based. Set explicit `cache_control` markers on the stable system+repo prefix so the cache hit rate is high across the triage→planner→executor sequence (they all see similar repo context). Significant cost lever for Week 4+.

5. **`polish-eval-baseline-tracking`** (P2). Commit eval result digests (just the summary.json `aggregates` block) to the repo so per-commit comparisons are visible. Defer initial design until we've run a few eval cycles.

6. **`gap-no-task-source-resumption`** (gap). If a GitHub run fails and a human re-labels `agent-ready` after edits, Week 3 creates a brand-new Run. No state inherited from the previous attempt.

7. **`polish-planner-iterative-context-fetching`** (P2). The planner gets a fixed file-content snapshot. Real planning often needs to chase imports or find callers. Defer the iterative-read pattern (which would let the planner ask for more context mid-call) — needs tool use, more SDK plumbing.

The "Backlog discipline" rule says deferrals get logged at the moment they're decided. These will all become BACKLOG entries as soon as Phase A starts.

---

## Section G — Implementation order with checkpoints

### G1. Build sequence

```
Phase A — eval scaffold                                            (CHECKPOINT 1)
  A1. evals/tasks/ + 5 task fixtures (the ones designed in §A2)
  A2. Eval runner CLI: discover, copy base/, init git, drive a run, summarize
  A3. Result format: summary.json + per-task subdir
  A4. Baseline run: WITHOUT triage/planner — eval runner hand-rolls Spec
      directly from task.md for now. Establishes pre-Week-3 numbers.
  --> CHECKPOINT 1: review baseline. Without this, we cannot measure
      regression in later phases. Decide whether to proceed.

Phase B — .env + SDK plumbing                                       (no checkpoint)
  B1. packages/runtime/src/config/dotenv.ts loader
  B2. @anthropic-ai/sdk dep (pinned)
  B3. SDK client factory in runtime (createAnthropicClient(apiKey)),
      injectable for tests
  B4. ANTHROPIC_API_KEY validation in `agent-loop start` (only when
      a phase that needs it is in the path)

Phase C — tasks table + TaskSource interface                       (no checkpoint)
  C1. Migration #4: tasks table (per §D4 schema)
  C2. Store methods: insertTask, getTask, listTasksBySource
  C3. TaskSource interface type in runtime (no impls yet)
  C4. Run.taskId stays as branded string; tasks table is the persistence

Phase D — triage agent                                              (CHECKPOINT 2)
  D1. agents/triage.ts + triagePrompt + triageSchema + triageValidate
  D2. agents/repoContext.ts
  D3. tickTriaging wires triage into the loop; failure event mapping
  D4. Eval runner gains a "triage mode": task.md -> triage -> spec
  D5. Add 2 new eval tasks that exercise triage specifically. The
      original 5 are executor-stress; they hit 100% in the Phase A
      baseline, which means they can only show degradation, not
      improvement, with triage in the loop. The 2 new tasks are the
      ones that actually measure triage:

       - **One deliberately vague task** (~50 words, no file paths
         named). Tests triage's ability to extract structure from
         minimal input. Without triage the runner's hand-rolled spec
         from task.md should be too thin for the executor to act on
         correctly.
       - **One repo-introspection task** — task description references
         behavior, not files. The agent has to identify which files
         matter by reading the repo. Tests triage's use of repoContext.

      Acceptance gate for these 2: triage must produce a valid Spec
      (not a rejection) AND the executor passes against that spec.
      Acceptance gate for the BASELINE (no triage): both tasks should
      FAIL — that's how we know they actually require triage.
  --> CHECKPOINT 2: run pnpm eval against the 7-task suite. Expected:
       - Original 5 tasks: ≥80% pass (baseline was 100%; some
         degradation is acceptable, none would be ideal).
       - 2 new triage-stress tasks: ≥1 of 2 passing on the first
         triage prompt — we expect prompt iteration. CHECKPOINT 2 is
         the prompt-iteration gate, not a single-shot evaluation.
       - Both new tasks should have FAILED in baseline (run them
         once in baseline mode to confirm — if they pass without
         triage, they're not testing what we think).

Phase E — planner agent                                             (CHECKPOINT 3)
  E1. agents/planner.ts + plannerPrompt + plannerSchema + plannerValidate
  E2. tickPlanning wires planner; failure event mapping
  E3. Cross-phase budget enforcement (per §F1)
  E4. Add 1 new eval task exercising cross-file refactor planning
  --> CHECKPOINT 3: full eval suite (triage + planner + executor +
      verifier). Confirm pass rate within 10% of baseline. If worse,
      fix prompts before proceeding to GitHub.

Phase F — GitHub Issues source                                      (CHECKPOINT 4)
  F1. sources/github.ts with GhTaskSource (gh CLI via injectable runner)
  F2. CLI flag --source github --repo --target (and optional --issue)
  F3. Label conventions + state transitions (per §D2)
  F4. PR-opener integration: read tasks table, append "Closes #N" when
      source is github
  F5. Live smoke: open an issue on agent-loop-target with label
      agent-ready, run agent-loop start, verify PR linked back
  --> CHECKPOINT 4: this IS the Week 3 demo.

Phase G — sprint wrap-up
  G1. Final eval suite run on main; commit the summary as a baseline
  G2. BACKLOG: add all deferred entries from §F5, plus anything new
      discovered during the build
  G3. QUALITY.md: tick off the newly-measurable metrics
  G4. CLAUDE.md additions (per §F4)
```

### G2. Per-step scope, risks, definition of done

| Phase | Rough scope | Key risks | Definition of done |
|-------|-------------|-----------|--------------------|
| A — eval scaffold | ~4 commits | Tasks too easy → eval becomes flattery; too hard → no signal | `pnpm eval` runs end-to-end; baseline pass rate ≥80% on hardcoded-spec mode (QUALITY Tier 1 target). |
| B — .env + SDK | ~2 commits | SDK version pinning, accidental key leakage | `agent-loop start --source github` errors loudly without a key; tests run with a mocked SDK; no real key needed in CI. |
| C — tasks + interface | ~2 commits | Migration idempotency on existing DBs | All existing tests still pass; migration #4 is idempotent; Store roundtrips Task rows. |
| D — triage | ~4 commits (prompt iteration likely) | Prompt produces specs that look fine but executor can't act on | Triage produces a valid Spec on the 1–2 triage-targeted eval tasks at ≥80% pass rate; cost per triage call ≤$0.02 (Haiku, with caching). |
| E — planner | ~3-4 commits | Sonnet cost surprise; verbose plans bloat artifacts | End-to-end eval pass rate within 10% of Phase D; per-task median cost ≤$0.50 (QUALITY Tier 5). |
| F — GitHub source | ~3-4 commits | `gh` CLI auth + rate-limit edge cases on real demo | Live demo on agent-loop-target works: agent-ready issue → labels transition correctly → PR opens with "Closes #N" → issue auto-closes on merge (manual merge by user). |

### G3. First checkpoint: baseline numbers BEFORE triage

CHECKPOINT 1 is the load-bearing one. Concretely:

After Phase A lands, run `pnpm eval` against the 5 tasks using ONLY the executor path (Week 2 baseline). Eval runner converts `task.md` → Spec by hand (templated): title from first line, description = full task.md, fileScope inferred from the base/ tree, acceptanceCriteria copied verbatim from expected.json, testCommands copied verbatim.

We record:
- Pass rate (target ≥80%).
- Median + p95 cost per task.
- Median + p95 cache hit rate.
- Per-phase token totals (only executor in Phase A; later phases will be added).

This number is what every later phase compares against. If after Phase D, pass rate drops from 100% to 60%, we know triage isn't good enough and the prompt needs iteration.

---

## Section H — Open questions and one-way doors

### H1. Irreversible architectural choices

| Choice | Recommendation | Alternative |
|--------|----------------|-------------|
| `tasks` table schema (migration #4) | Include `source_metadata_json TEXT NULL` from the start; cheap forward-compat for labels/assignees | Pure minimal schema; add columns later via migrations. Marginal cost either way; I prefer including the metadata column now. |
| `TaskId` format becomes structured | Prefix with source id: `github:owner/repo#42`, `local:hardcoded`, `eval:add-clamp`. Parsing surface kept tiny — only the GitHub PR-link code parses. | Opaque UUID, structure in `source_metadata_json`. Less forgiving to future readers; loses grep value. |
| `--spec` vs `--source` CLI flag shape | Keep both; mutually exclusive; validate at parse time | Collapse into one `--from <kind:value>` super-flag. Two flags is more discoverable to a user; less elegant. |
| Spec gains a `linkedIssue` field? | **No** — PR opener resolves via Run.taskId → tasks table. Spec stays pure. | Add `linkedIssue?: { number, url }` to Spec. Easier reads, but couples Spec to issue-tracker semantics. |
| Eval runs DB location | `evals/runs.db` (project-scoped, gitignored) | `~/.agent-loop/eval-runs.db` (user-scoped). Project-scoped is right because eval results characterize THIS codebase, not THIS user. |
| Use of Zod or other validation lib | **No** — hand-rolled validators per CLAUDE.md disposition | Zod adds a dep but cuts validator code ~50%. Defer; revisit if validator code balloons. |
| Anthropic SDK version | Pin tightly (e.g., `1.2.3` not `^1.2`) | Caret range. Pin tight: eval reproducibility matters; SDK API surface moves. |

### H2. Prompt-design choices I'm 80% on (will iterate)

1. **Triage repo context layout (~10 KB: tree + README + package.json + CLAUDE.md).** Could need more (function signatures, type definitions) or less. Iterate based on eval pass rate.
2. **Triage rejection threshold — lean toward producing a spec for borderline cases.** Will tighten if we see junk specs.
3. **Number of examples in triage system prompt — 2-3 worked pairs.** Might be 1 (less context cost) or 5 (more behavioral pinning).
4. **Planner output format — `risks` required (can be empty array, not omitted).** Forces the model to consider failure modes explicitly. Alternative: make optional and let the model decide.
5. **Planner file-content cap (30 KB).** Sonnet can handle more, but the cost climbs linearly. Adjust based on observed pass rate vs cost.
6. **Validator retry policy — exactly 1 retry, with feedback inlined.** Could be 0 (fail fast) or 2 (more tolerant).

### H3. Explicit signoffs requested before code lands

1. **Use of `@anthropic-ai/sdk` as the SDK dep (no Zod).**
   _Resolution: signed off; revisit if total validator code crosses ~200 lines._
2. **Eval DB location: `evals/runs.db` (project-scoped, gitignored).**
   _Resolution: signed off._
3. **Pinning the Anthropic SDK version tightly.**
   _Resolution: signed off._
4. **GhTaskSource adds comments to GitHub issues** at each state transition (markStarted/Done/Failed/NeedsInfo).
   _Resolution: signed off, with refinement. Constructor takes `{ quiet?: boolean }` (default `false`); CLI exposes via `--quiet`. Default = comments-on (audit trail for the demo repo); real repos will eventually run with `--quiet`. See §D2._
5. **Eval runner exit code: non-zero if any task fails** (continues running all tasks regardless).
   _Resolution: signed off — CI-friendly._
6. **Hardcoded-spec bypass continues to skip BOTH triage AND planner** — gives us an offline-friendly executor smoke path.
   _Resolution: signed off (called out as critical)._
7. **The TaskSource interface as designed in §D1.**
   _Resolution: signed off after the catch-5 amendment. `fetchById(taskId)` added to the interface to support the `--issue <n>` path without filtering through `fetchNew`._
8. **The exact wording of the 5 eval task `task.md` files.** This is the input to triage forever — it is the highest-stakes design choice in the plan and is recorded in §A2.
   _Resolution: catches 1–3 from the kickoff response updated the wording for `add-clamp`, `fix-off-by-one`, and `rename-export` — see §A2 for the final text. Tasks 3 (`extract-helper`) and 5 (`add-edge-case-tests`) are unchanged from the original plan and I have no push-back on either: `extract-helper`'s "your call where" is the right judgment-testing knob, and `add-edge-case-tests` enumerates the cases concretely with explicit "don't modify src/" instruction. Signed off._

---

## Appendix — what this plan does NOT cover

- **Polling/daemon mode** for the task source. Still tracked as `polish-daemon-vs-oneshot` in BACKLOG.
- **Iterative planner** that can request additional files mid-call. Deferred (`polish-planner-iterative-context-fetching`).
- **Multi-issue parallel runs.** Sequential only in Week 3.
- **Prompt A/B testing tooling.** Manual prompt iteration via eval pass rate diffing.
- **Cost dashboards.** `evals/results/<timestamp>/summary.json` is the source. Visualization later.
- **Long-context planning for very large repos.** The 30 KB file-content cap will hurt eventually. Defer until we see a repo where it matters.
