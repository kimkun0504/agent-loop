# agent-loop

An orchestrator for running autonomous coding agents against your own repos.

## Why this exists

Off-the-shelf agent tools work great until you need them to do something specific, reliably, repeatedly, on real production code. At that point you discover that what you actually need is not a smarter agent — it's better scaffolding around an existing one. This project is that scaffolding.

## Design principles

1. **The agent is the cheapest, least reliable component.** Design around its failures, not its successes.
2. **Observability beats cleverness.** Every state change is logged as a structured event. You can replay any run from history.
3. **Task quality dominates agent quality.** A great agent on a vague task produces garbage. Most engineering effort here goes into the task pipeline (triage → spec → plan → execute → verify), not into the executor.
4. **Pure core, dirty edges.** The state machine and schema are pure functions and data. All I/O (DB, filesystem, agents, network) lives in `runtime/`. This makes the brain testable in milliseconds.
5. **Defense in depth.** Worktrees, Docker containers, scoped tool permissions, token budgets, wall-clock limits, a kill-switch file. No single layer is trusted.

## Architecture

```
Inbox (issues, tasks)
    ↓
Triage agent (Haiku)        → produces structured Spec
    ↓
Spec approval (human/auto)
    ↓
Planner agent (Sonnet, RO)  → produces Plan
    ↓
Plan approval (human/auto)
    ↓
Executor agent (Opus, RW)   → implements in worktree+Docker
    ↓
Verifier (independent)      → tests + lint + semantic check
    ↓
PR opened
```

Each phase is a separate process invocation. Between phases, state lives in SQLite + on-disk artifacts (`runs/<run_id>/`).

## Repo layout

```
packages/
  core/         Pure: types, state machine, schema, logger. No I/O.
  runtime/      I/O: DB, worktrees, Docker, agent invocations, gh CLI.
  cli/          Thin commander wrapper over runtime.
  vscode/       Later. A webview over the CLI.
examples/
  livekit-app/  Test target repo.
evals/
  tasks/        Known-good tasks for regression testing.
```

## Current status: Week 1 — Foundation

- [x] Project skeleton (pnpm workspace, TS, Vitest)
- [x] Core domain types with branded IDs
- [x] State machine (pure, exhaustively tested)
- [x] Structured logger (JSONL + pretty stdout)
- [x] SQLite schema
- [ ] Migration runner (runtime/)
- [ ] DB query layer (runtime/)
- [ ] CLI skeleton with `start`, `list`, `inspect`, `stop`

## Roadmap

- **Week 2:** End-to-end thin slice. One hardcoded spec → executor in worktree → exit-code verifier → PR. No triage, no planner, no Docker yet.
- **Week 3:** Add the missing layers — triage, planner, Docker isolation, LLM-based verifier.
- **Week 4:** Eval harness. Ten real tasks from `examples/livekit-app`. Measure pass rate.

## State machine

The full phase set is in `packages/core/src/types/index.ts`. The transition function is in `packages/core/src/state/transition.ts`. Read those two files first; everything else builds on them.

Phases:

```
queued → triaging → awaiting_spec_approval
       → planning → awaiting_plan_approval
       → executing → verifying → opening_pr → done

(any non-terminal) → failed | abandoned
```

## Safety: the STOP file

A file named `STOP` in the orchestrator's working directory halts all new work before the next phase begins. This is the single-character kill switch. Touch it when something looks wrong.

## Development

```bash
pnpm install
pnpm -F @agent-loop/core test
pnpm -F @agent-loop/core typecheck
```

## Things this project will not do

- Auto-merge PRs. Ever.
- Run an agent without a worktree.
- Trust the executor to declare success — verification is independent.
- Talk to production secrets or credentials.
- Build its own model. Off-the-shelf Claude with great scaffolding.
