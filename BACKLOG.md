# Backlog

The ledger of debt, deferred decisions, and known gaps. This file is the single source of truth for "we owe ourselves." When in doubt about whether something belongs here, add it — over-tracking is cheap, under-tracking compounds.

## Rules

1. **Every shortcut gets written down the moment it's taken.** Not "later." Not in commit messages alone. Here. The commit message can reference the entry (`see BACKLOG.md#polish-token-tracking`).
2. **No silent removal.** Items move to `Resolved` with a date and the commit that closed them. They are never deleted.
3. **Severity is honest.** `P0` = blocks Week N+1 work. `P1` = should be fixed in the next polish sprint. `P2` = nice to have. If everything is P0, severity means nothing.
4. **Owner is stated.** Either `human` (must be done by you), `agent` (delegate to Claude Code), or `either`. No unowned items.
5. **Polish sprints are scheduled, not improvised.** A polish sprint runs after each "Week N" feature push, before the next one starts. The sprint burns down P0 and P1 items added since the last sprint.
6. **Quality bar gates apply.** No item in `Polish debt` may be marked `Resolved` unless the changes pass the quality bar in `QUALITY.md`.

## Polish debt

Things that work but aren't right. Items here came from real shortcuts taken during a build.

| ID | Severity | Owner | Description | Added | Resolved |
|---|---|---|---|---|---|
| `polish-verifier-logging-symmetry` | P1 | agent | Verifier emits `running test command` on entry but no `command end` line on success — only on failure. Makes timing analysis impossible from the log alone. Fix: emit a `verifier: command end` line at INFO level on every command completion, regardless of exit code. | 2026-05-23 | — |
| `polish-orphan-branch-cleanup` | P1 | agent | Failed runs leave orphan `agent/<runId>` branches on the remote, AND successful runs leave the local worktree directory on disk (see `polish-worktree-cleanup`). Bumped from P2 to P1 because the two issues are one piece of work: an `agent-loop gc` subcommand that, for any Run in a terminal phase older than N days, removes the worktree directory and (optionally) the remote branch. Default N=7. **Resolve together with `polish-worktree-cleanup`.** | 2026-05-23 | — |
| `polish-worktree-cleanup` | P0 | agent | Successful runs (`phase=done`) leave their worktree at `~/.agent-loop/worktrees/<runId>/worktree` on disk forever. No code path calls `removeWorktree`. Direct violation of QUALITY Tier 1: "Orphan worktrees after a run: 0 — every completed run cleans up its worktree directory." The smoke run's worktree at `run-8ad39c33` is still on disk as I'm writing this. Local-disk half of the GC story; the remote-branch half is `polish-orphan-branch-cleanup`. **Resolve together with `polish-orphan-branch-cleanup`** — same `agent-loop gc` subcommand handles both. | 2026-05-23 | — |
| `polish-artifacts-dir-unused` | P0 | agent | `tickExecuting` does `mkdirSync(<artifactsDir>/<runId>/)` but nothing writes there. `ExecutorResult.outputLog` (full agent transcript), verdict per-command output, and any per-phase log all live only in memory and the shared `cli.log`. `Run.artifactDir` is a dead pointer. Promoted from P1 to P0: Week 3 adds 3-4 LLM calls per run with more failure modes, and post-mortem on a failed run is intractable without the agent transcript on disk. This is foundational observability, not polish. Must land before triage/planner. Fix: write `executor.log`, `verdict-<n>.json`, and an `events.jsonl` under each run's artifact dir from tick.ts. | 2026-05-23 | — |
| `polish-scaffold-test-touches-real-home` | P1 | agent | `packages/cli/test/scaffold.test.ts` spawns the real `./bin/agent-loop` via execa without setting `$AGENT_LOOP_HOME`. Every test run touches the host's real `~/.agent-loop/` and creates `runs.db`, `worktrees/`, `artifacts/`, `cli.log`. Confirmed during the smoke run — stale state was from earlier test passes, not from any actual CLI invocation. CI safety issue and a local footgun. Fix is one line: `env: { ...process.env, AGENT_LOOP_HOME: tmpdir() }` in the execa call. | 2026-05-23 | — |
| `polish-file-scope-not-enforced` | P1 | either | `Spec.fileScope` is included in the executor prompt as advisory but the executor doesn't enforce it — the agent has full write access to the entire worktree. QUALITY Tier 4 tracks "writes outside its worktree" as 0, but writes *inside* the worktree but *outside scope* are unpoliced. Three options to decide between as part of the fix: **(a)** Soft enforcement at the verifier — run `git diff --name-only` against the scope globs after execution and fail the run if any out-of-scope path changed. Cheap, after-the-fact, no executor changes. **(b)** Hard enforcement at execution — hook into the agent's file-write tool calls and block them before the edit lands. Expensive, requires deeper SDK integration than the current CLI-spawn approach. **(c)** Acknowledge `fileScope` is advisory and downgrade or remove the field from the `Spec` type so the contract matches reality. This is a real architectural decision, not just an implementation gap — pick (a), (b), or (c) as part of the fix. | 2026-05-23 | — |
| `polish-agent-commit-no-verify` | P2 | either | The agent's commit in `commitAgentChanges` uses `git commit --no-verify`, skipping target-repo pre-commit hooks. Reasonable for the Week 2 demo (we don't know what hooks a target has, and prompts could block on them) but means agent-produced PRs might fail the target's own lint/format conventions. Future fix likely needs a per-spec knob (`spec.runHooks?: boolean`) or a smarter retry-on-hook-failure flow. | 2026-05-23 | — |
| `polish-start-output-omits-verdict` | P2 | agent | `start.ts` prints `formatRunDetail(final)` plus the PR URL at the end, but not the verdict. If a run fails verification, the terminal output shows only `Failed: [verification_failed] one or more test commands did not exit 0` — the user has to run `agent-loop inspect <runId>` separately to see which command failed and what it printed. Two more lines to call `formatVerdict(latestVerdict, 0)` when a verdict exists. | 2026-05-23 | — |
| `polish-runcommand-spawn-contract-deviation` | P2 | agent | `runCommand` returns `{ spawnFailed: true, exitCode: -1 }` on ENOENT instead of throwing. This is a deviation from the v2 plan, which mentioned only "Forwards SIGTERM" about the contract. Documented in commit `d359ac8`'s body but the BACKLOG discipline says deviations from agreed plans belong here. The contract is sensible — consumers always inspect exit codes anyway — entry exists for honesty of record, not because the design is wrong. | 2026-05-23 | — |
| `polish-examples-specs-workspace-membership` | P2 | either | The agreed location for `examples/specs/` was "top-level, loose folder, parallel to `examples/livekit-app/`". To make TypeScript resolve `@agent-loop/core` from those files, I made `examples/specs/` a private workspace member with its own `package.json` (commit `993bd54`). Implementation works; the deviation is small but recorded per discipline. If a non-workspace approach becomes viable (build step plus `paths` mapping, or a different import strategy), revisit. | 2026-05-23 | — |
| `polish-template-literal-backtick-workaround` | P3 | agent | `pr/open.ts` uses `String.fromCharCode(96)` to produce a literal backtick in the PR body because the obvious template-literal escape for a literal backtick character was tripping a parser bug (`tsc` reported "Unterminated template literal" at EOF). The codepoint workaround is in place but the root cause was never investigated — possibly a TS or esbuild bug, possibly a subtle file encoding issue. Worth a closer look if anyone hits the same pattern elsewhere. | 2026-05-23 | — |
| `polish-daemon-vs-oneshot` | P1 | agent | `runLoop` is daemon-shaped (polls forever) but `start` needs one-shot semantics. Week 2 worked around this by replacing `runLoop` in `start` with a direct tick loop. The clean version: keep `runLoop` as-is, expose `tickUntilTerminal(deps, run)` as a separate primitive in the orchestrator, and have `start` use that. Then `agent-loop daemon` (future) uses `runLoop` properly. | 2026-05-23 | — |
| `polish-deferred-token-tracking-original-comment` | P2 | agent | The TODO comment that should sit on `ClaudeCliExecutor` documenting the deferred token-tracking decision was never added (called out in the Week 2 review but not written). When `polish-token-tracking` is fixed, this is moot. Resolve as superseded if so. | 2026-05-23 | — |
| `polish-cli-bin-aspirational` | P1 | agent | `packages/cli/package.json` declares `bin: { "agent-loop": "./src/index.ts" }` but Node cannot execute TS directly. Currently the user invokes via `pnpm --filter @agent-loop/cli exec agent-loop`. Fix: add `tsx` as a runtime dep and shebang the entry, OR add a build step and point `bin` at the built file. Decide as part of the fix. | 2026-05-23 | — |

## Known gaps

Features the system does not have yet, by design, but that affect the quality bar. These are not bugs — they're scope. Listed so we don't pretend they don't exist.

| ID | Description | Target |
|---|---|---|
| `gap-no-triage` | Specs are hardcoded in `examples/specs/`. Users cannot submit a vague task and have it converted to a structured spec. | Week 3 |
| `gap-no-planner` | The executor runs immediately on `plan_approved` with no actual plan. The `plans` table exists but is never written to. | Week 3 |
| `gap-no-semantic-verification` | Verifier only runs exit-code commands. No LLM-based check of "does the diff match the spec." | Week 3 |
| `gap-no-task-source` | No integration with a task queue. Specs are passed via `--spec <name>` referencing a hardcoded registry, and `Run.taskId` is set to the literal `'hardcoded'` for every Week 2 run — the field is meaningless until this gap is closed. | Week 3 |
| `gap-no-docker-isolation` | Executor runs in a git worktree but with full host filesystem and network access. Adequate for trusted single-user use; inadequate for any multi-tenant scenario. | Week 4 |
| `gap-no-eval-harness` | No regression suite of representative tasks. Cannot measure whether a prompt change improves or regresses behavior. | Week 3 (concurrent with triage/planner) |
| `gap-no-parallel-runs` | One run at a time. The architecture supports parallel via worktrees and SQLite version-guarded updates, but the loop is single-threaded. | Week 5+ |
| `gap-no-cost-budget-enforcement` | Token budgets exist in the spec but are not enforced at runtime. A runaway agent can exceed `budget.maxTokens` without being stopped. | Week 3 (depends on `polish-token-tracking`) |
| `gap-no-secrets-handling` | No story for the agent needing API keys or env vars in the target repo. Currently the agent has whatever the user's shell has. | Week 5+ |

## Quality bar checklist

Before any item in `Polish debt` moves to `Resolved`, the change must satisfy:

- [ ] All package tests pass (`pnpm -r test`)
- [ ] All packages typecheck (`pnpm -r typecheck`)
- [ ] No new ESLint warnings introduced (when lint exists — `gap-no-lint` to be added when relevant)
- [ ] The fix is covered by a new or updated test
- [ ] The fix is described in a conventional commit referencing the BACKLOG entry ID
- [ ] If the fix involved a tradeoff, the tradeoff is documented in the commit body
- [ ] If the fix changed a public API in `@agent-loop/core` or `@agent-loop/runtime`, the change is noted in `CHANGELOG.md` (to be created — `gap-no-changelog`)

## Polish sprints

A polish sprint runs after each Week N feature push. Sprint burns down P0 and P1 items added during that week. P2 items roll forward.

| Sprint | Window | Items closed | Items deferred |
|---|---|---|---|
| Post-Week-2 | (not yet run) | — | — |

## Resolved

Items that have been fixed. Format: `ID | Severity | Description | Resolved date | Closing commit`.

To find a closing commit by id: `git log --grep 'closes BACKLOG#<id>'`.

| ID | Severity | Description | Resolved date | Closing commit |
|---|---|---|---|---|
| `polish-token-tracking` | P0 | `ClaudeCliExecutor` now invokes `claude --output-format json` and parses the result via `parseClaudeJsonOutput`. Token usage flows through new optional `ExecutorResult.usage` and `record_token_usage` event payload, with `Run.tokensSpent` accumulating the sum of all four token kinds (input/output/cache_read/cache_creation). Wall-clock recorded via `record_time_spent`. Fixture-driven parser tests guard against future CLI schema changes. | 2026-05-23 | `closes BACKLOG#polish-token-tracking` |
| `polish-pr-url-not-persisted` | P1 | `pr_opened` event payload gains `url: string`; `Run.prUrl` set by the transition. Migration #3 adds `pr_url` to the runs table. CLI inspect shows `prUrl` in the run header and `url=...` in the event summary. `start.ts` reads `final.prUrl` after the loop instead of the previous closure-capture hack. | 2026-05-23 | `closes BACKLOG#polish-pr-url-not-persisted` |
