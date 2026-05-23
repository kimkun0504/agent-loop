# Conventions for agent-loop

This file is read automatically by Claude Code. Keep it short and concrete.

## Stack
- TypeScript (strict mode, ES modules)
- Node 20+
- pnpm workspaces
- Vitest for tests
- SQLite (better-sqlite3) for state, when we get to the runtime package

## Hard rules
- **`packages/core` must remain I/O-free.** No `fs`, no `child_process`, no network, no DB connections. Types, pure functions, and data only. If you find yourself wanting I/O in core, the thing belongs in `runtime/`.
- **No `console.log`.** Use the logger from `@agent-loop/core/logger`.
- **No `any`.** Use `unknown` and narrow. If you need an escape hatch, leave a comment explaining why.
- **Branded IDs.** Don't pass raw strings as `RunId`/`SpecId`/`TaskId`. Use the constructor functions.
- **Timestamps are ISO 8601 strings**, not `Date` objects, across module boundaries.

## Backlog discipline

`BACKLOG.md` is the single source of truth for deviations, shortcuts, and deferred work. `QUALITY.md` is the bar a fix must clear before its backlog entry can be closed. Both files exist at the repo root — read them.

1. **Deviate → write it down, same commit.** When you take a shortcut, skip something the plan called for, or land a fix that isn't the right fix, add an entry to `BACKLOG.md` under `Polish debt` *in the same commit*. The commit body must reference the entry by ID. Calling out a deviation only in a commit message is forbidden — commit messages are not greppable as a ledger, and history rewrites lose them.
2. **Feature done → propose backlog entries before moving on.** When you finish a feature (any task that earned its own conventional commit `feat:`), pause and propose entries for any shortcuts, deferred decisions, or known gaps introduced during it. Do this *before* starting the next feature. Surface them to the human for confirmation; don't silently roll into the next thing.
3. **Resolve only against the quality bar.** Before flipping a backlog item to `Resolved`, verify the change satisfies `QUALITY.md`'s checklist (`pnpm -r test`, `pnpm -r typecheck`, new/updated test for the fix, no Tier 1 metric regression). If any item on the checklist fails, the entry stays open and the commit references it with `references` rather than `closes`.
4. **Commit message references use a fixed pattern.** Use `closes BACKLOG#<id>` to mark an entry resolved, or `references BACKLOG#<id>` to point at it without closing. IDs are the backtick-wrapped slugs from `BACKLOG.md`'s table — e.g. `closes BACKLOG#polish-token-tracking`. A commit may close or reference multiple IDs.

## State machine
- The state machine in `packages/core/src/state/transition.ts` is the source of truth for what can happen.
- To add a new event or phase: edit the types, edit the TRANSITIONS table, add tests covering the new transitions AND the invalid-from-other-phases case.
- Never bypass `transition()` to mutate a `Run`. The DB layer persists what `transition()` returns; it does not invent state.

## Testing
- `pnpm -F @agent-loop/core test` runs the core tests.
- Every state-machine change needs both happy-path and invalid-transition tests.
- Tests should be deterministic — pass a fixed `now` string, not `new Date()`.

## Style
- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Imports use `.js` extensions even for TS files (ESM requirement).
- Prefer `const` and pure functions. Reach for classes only when there's mutable state (the Logger is the current example).
- Keep functions short. If a function has more than ~50 lines, ask whether it should be split.

## What not to do
- Don't introduce a runtime dependency in `packages/core`. It must stay zero-dep.
- Don't add a logging framework. The hand-rolled logger is intentional — it's ~100 lines and we own it.
- Don't add an ORM. SQL strings are fine for this scale.
- Don't build the VS Code extension yet. CLI first.
