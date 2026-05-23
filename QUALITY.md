# Quality bar

What "production-grade" means for agent-loop, in measurable terms. This is the bar a feature must clear before it ships. It's the bar a backlog item must clear before it's marked resolved.

If a metric here can't be measured, it doesn't belong here. "Reliable" is not a bar. "p95 task completion under 10 minutes" is.

## Why this exists

The user said: "staff engineer level one that would actually be used by Anthropic, Google, or Meta." That standard isn't met by being careful. It's met by having a bar that's external, written down, and applied consistently — including (especially) when it's inconvenient.

If a feature is great but the eval pass rate dropped, the feature doesn't ship until the eval is restored or the eval set is explicitly updated with reasoning. The bar is the contract. The bar wins arguments.

## Tier 1: Correctness

The system must do what it says it does.

| Metric | Target | How measured |
|---|---|---|
| Eval pass rate | ≥ 80% of tasks in `evals/tasks/` produce a verdict.pass=true verdict on a clean run | `pnpm eval` (to be built) runs each task; pass counted |
| State machine determinism | 100% — replaying the event log of any past run produces the same final Run state | Replay test in `packages/core/test/replay.test.ts` (to be built) |
| Test suite passing | 100% on every commit to main | `pnpm -r test` in CI (CI to be built) |
| Typecheck passing | 100% on every commit to main | `pnpm -r typecheck` in CI |
| Zero-token runs | 0% — no completed run reports `tokensSpent: 0` | Assertion in the eval harness |
| Orphan worktrees after a run | 0 — every completed run cleans up its worktree directory | Filesystem check after eval suite |

## Tier 2: Performance

The system must be fast enough to use.

| Metric | Target | How measured |
|---|---|---|
| p50 task completion time | ≤ 3 minutes (small bounded task, no triage) | Eval suite timing |
| p95 task completion time | ≤ 10 minutes | Eval suite timing |
| Orchestrator overhead per phase | ≤ 200ms (excluding LLM and subprocess time) | Per-phase duration logged; orchestrator overhead = duration − (LLM_ms + subprocess_ms) |
| SQLite query latency p95 | ≤ 50ms for any single Store method call | Logger captures query times |
| Cold-start to first executing tick | ≤ 5 seconds | Wall clock from `agent-loop start` to first `tick: phase=executing` log line |

## Tier 3: Observability

When something goes wrong, you must be able to explain why.

| Metric | Target | How measured |
|---|---|---|
| Every Run has a complete event log | 100% — every Run has a sequence of events from `start_triage` to a terminal phase, with no gaps | Replay verification in eval harness |
| Every phase emits symmetric start/end logs | 100% — every `X: starting` / `X: running` log line has a matching `X: end` / `X: succeeded` / `X: failed` line | Log audit script (to be built) |
| Cost per run is reported | 100% of completed runs report nonzero `tokensSpent` and `secondsSpent` | Eval suite assertion |
| Stuck runs are detectable | A run in a non-terminal phase for > `budget.maxSeconds * 1.5` triggers a warn-level log | Loop tick logic |
| Failures include category and phase | 100% of `failed` runs have `failure.category` and `failure.phase` populated | Eval suite assertion on failure cases |

## Tier 4: Safety

The system must not damage things outside its lane.

| Metric | Target | How measured |
|---|---|---|
| Agent writes outside target repo | 0 occurrences | Filesystem audit after each eval task |
| Agent writes outside its worktree | 0 occurrences | Filesystem audit after each eval task |
| Auto-merge of PRs | 0 — explicitly forbidden, no code path can trigger merge | Code review; absent code → trivially true |
| Modifications to agent-loop's own source from inside an agent run | 0 occurrences | Filesystem audit |
| Force-push to a non-`agent/*` branch | 0 occurrences | Git audit |
| Operations on credentials, env files, or `.git/config` | 0 occurrences | Filesystem audit on `.env`, `.git/config`, `~/.ssh`, `~/.aws`, `~/.netrc` |

## Tier 5: Cost discipline

Running the system must not be a surprise bill.

| Metric | Target | How measured |
|---|---|---|
| Token budget enforcement | A run exceeding `budget.maxTokens` transitions to `failed` with category `budget_exceeded` within one tick | Test in `packages/runtime/test/orchestrator/` |
| Cost per task (median) | ≤ $0.50 for the eval suite's small-bounded tasks (Week 3 baseline; revisit as task complexity grows) | Eval suite cost report |
| No silent retries that double cost | Retries are explicit in the state machine; no LLM call is invoked twice for one phase without an `increment_attempt` event | State machine invariant |

## How the bar is applied

**Before merging any feature PR** (when we get to CI):

```
pnpm -r test           # Tier 1
pnpm -r typecheck      # Tier 1
pnpm eval              # Tier 1, 2, 3, 5
pnpm audit:logs        # Tier 3
pnpm audit:filesystem  # Tier 4
```

All five must pass. Until CI exists, these are run manually by the human reviewer (you) before approving a Claude Code commit batch.

**For a backlog item to be marked Resolved**, the change must:
1. Pass everything above
2. Not regress any Tier 1 metric
3. Be reflected in `BACKLOG.md` Resolved section with the closing commit

**For a "polish sprint" to be considered complete**, no P0 polish items from the previous Week may remain open.

## What's deliberately not on this bar

To prevent scope creep into "production-readiness theater":

- Uptime / availability — this is a local tool, not a service
- Multi-user / multi-tenant — single user is the design point through Week 5
- Authentication / authorization — single user, single machine, no auth surface
- Localization, accessibility — N/A for a developer CLI
- Performance under high concurrency — single-run model is by design

If we add any of these later, they become tiered metrics here. Adding "high availability" is a non-trivial architectural shift, not a polish item.

## Open quality questions

Things we haven't decided how to measure yet. Move out of this section when a measurement is defined.

1. **"Did the agent produce code a human reviewer would actually merge?"** Currently approximated by exit-code verifier (Tier 1 eval pass rate). The closer proxy is: of PRs that pass verification, what fraction does the human merge as-is vs. require changes? Need to track manually after each eval run for now. Move to automated tracking when GitHub Issues integration lands.
2. **"Is the agent's plan good?"** Once the planner exists, we need a way to score plan quality. Currently no defined metric. Proposal: a held-out set of (spec, ideal-plan) pairs, and judge similarity. Defer until planner ships.
3. **"Is the system getting better over time?"** Eval pass rate over weeks is the proxy. Need to commit eval results to the repo so the trend is visible.
