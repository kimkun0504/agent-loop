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
