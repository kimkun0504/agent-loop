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
| `polish-token-tracking` | P0 | agent | `ClaudeCliExecutor` reports `tokensSpent: 0` and `secondsSpent: 0` on every run. Cost observability is missing. Must be fixed before triage and planner agents land in Week 3 — otherwise we'll be making 3-4 LLM calls per task with no visibility. Approach: parse Claude CLI's output for token usage, or switch to the Anthropic SDK for executor invocations. Decide as part of the fix. | 2026-05-23 | — |
| `polish-verifier-logging-symmetry` | P1 | agent | Verifier emits `running test command` on entry but no `command end` line on success — only on failure. Makes timing analysis impossible from the log alone. Fix: emit a `verifier: command end` line at INFO level on every command completion, regardless of exit code. | 2026-05-23 | — |
| `polish-orphan-branch-cleanup` | P2 | agent | Failed runs leave orphan `agent/<runId>` branches on the remote. No automatic cleanup policy. Proposal: a `agent-loop gc` subcommand that lists and optionally deletes orphan branches where the corresponding Run is in a terminal failure phase older than N days. Default N=7. | 2026-05-23 | — |
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
| `gap-no-task-source` | No integration with a task queue. Specs are passed via `--spec <name>` referencing a hardcoded registry. | Week 3 |
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

(none yet)
