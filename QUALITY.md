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
| Eval pass rate (CHECKPOINT 3 gate) | Architectural-stability tasks (add-clamp, add-edge-case-tests, extract-helper, fix-off-by-one, rename-export, split-module): **5/5 valid runs at 100%**. Executor-capability tasks (infer-target-file): **≥3/5 valid runs at PASS** (stochastic by design). Documented rejections (vague-flaky-fix): continues to triage-reject per `gap-triage-thin-context`. Meta-test: **0 triage anti-pattern violations** across all valid runs. "Valid run" = executor was reachable; external infrastructure errors (Claude Code session-limit quota walls, network failures) excluded from the denominator. See `docs/per-criterion-verifier-refactor.md` for the refinement rationale. | `pnpm eval --with-triage`; per-task pass + `summary.json.triageAntiPatternViolations` |
| State machine determinism | 100% — replaying the event log of any past run produces the same final Run state | Replay test in `packages/core/test/replay.test.ts` (to be built) |
| Test suite passing | 100% on every commit to main | `pnpm -r test` in CI (CI to be built) |
| Typecheck passing | 100% on every commit to main | `pnpm -r typecheck` in CI |
| Zero-token runs | 0% — no completed run reports `tokensSpent: 0` | Assertion in the eval harness |
| Orphan worktrees after a run | 0 — every completed run cleans up its worktree directory | Filesystem check after eval suite |

**Caveat on eval pass rate.** Pass rate measures *correctness* of the agent's output, not *necessity* of each component in the loop. CHECKPOINT 2 (Week 3, Phase D) found that vague-spec eval tasks designed to require triage still passed in baseline-mode (no triage) because the executor with broad file-scope access often compensates for thin specs by reading the repo itself. **Triage's value-add (and later, the planner's) is not currently measurable by raw pass rate alone.** This is a known gap in the metric, not in the agents — tracked as `polish-eval-tasks-baseline-differentiation` in `BACKLOG.md`. Until that's resolved, when interpreting CHECKPOINT 2+ numbers: a baseline-vs-with-triage pass-rate delta near zero may mean triage adds no value, OR may mean the tasks aren't designed to require triage. Read the per-task breakdown and the per-phase cost / cache-hit numbers, not just the headline pass rate.

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
| Semantic verifier failure post-mortem | 100% — every semantic verifier failure produces an artifact containing the model's raw tool input | `<artifactDir>/<runId>/verdict-NNN.semantic-debug.json` written by `tickVerifying` when the verifier reports a validation failure; test in `packages/runtime/test/orchestrator/tick.test.ts` |

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
4. **"How do we tell when a polish item is genuinely P0 vs P1?"** The post-Week-2 backlog audit (see `docs(backlog): record shortcuts caught in post-Week-2 audit`) bumped two items from P1 to P0 — the existing BACKLOG rule ("P0 = blocks Week N+1 work") wasn't concrete enough to apply consistently. **Proposed rule:** a polish item is P0 if either (a) it directly violates a Tier 1 metric in this file — a target written as "0 occurrences" or "100%" that the current code fails (example: `polish-worktree-cleanup` violates "Orphan worktrees after a run: 0"); or (b) without the fix, the next planned Week's headline feature cannot be built without first kludging around it — the fix is a prerequisite, not parallel work (example: `polish-artifacts-dir-unused` is required infrastructure for Week 3's debug surface; you can't usefully ship a planner whose failures you cannot post-mortem). P1 is the same kind of issue without either condition — fix in the next polish sprint but doesn't block forward progress. P2 is honesty-of-record (deviations from agreed plans, sensible contract changes worth noting). P3 is curiosity (workarounds we want to understand someday). If this rule holds up across one or two more audits, promote it from open question to a stated convention in `BACKLOG.md`.
5. **"Are we accumulating triage-prompt-patching debt?"** CHECKPOINT 2 produced a triage-prompt patch for negated-grep semantics; CHECKPOINT 3 produced another for git-diff semantics. Both are in the same failure family — triage rewriting verifier commands incorrectly. Track the number of triage-prompt fixes per checkpoint as a leading indicator. **Rule:** if the rate doesn't trend toward zero by CHECKPOINT 5 (or the equivalent post-Phase-F milestone), the architecture is wrong, not the prompt — escalate `gap-triage-testcommand-pattern-debt` in `BACKLOG.md` and pick one of the design options (vocabulary-constrained triage, or split verification authoring). Track per-checkpoint: count = number of distinct triage-prompt patches landed between the prior checkpoint and this one. A trend of `[1, 1, 0, 0]` in successive checkpoints would close this question. A trend of `[1, 1, 1]` would not.
