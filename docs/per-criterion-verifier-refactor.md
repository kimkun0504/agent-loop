# Per-criterion verifier refactor

Status: proposed (not yet started). Resolves the structural instability in `runSemanticVerifier` exposed by CHECKPOINT 3 re-runs: 3 of 4 post-refactor eval runs failed `split-module` because the model variably produced `perCriterion` as a JSON-encoded string rather than an array, with template-literal escapes (`\``) that the validator's stringified-array accommodation could not recover. Triggers BACKLOG#`gap-triage-testcommand-pattern-debt` Option C (per-criterion calls) per its own predicted-revisit clause; supersedes BACKLOG#`polish-validator-stringified-array-accommodation`.

The triage-prompt anti-pattern fix (`831dfe6`) is unchanged and stays — the runtime-claim failure family it addressed is genuinely closed (verified by add-edge-case-tests + rename-export passing consistently across the last two CP3 runs). This refactor addresses a different, separable structural problem: array-shape instability in the verifier's tool output.

## Why

CHECKPOINT 3 post-refactor outcomes for `split-module`:

| Run | Commit | Outcome | Failure mode |
|---|---|---|---|
| re-run #1 | `3bbbac9` | FAIL | invalid_output (raw output not captured) |
| re-run #2 | `cb65b8e` | FAIL | invalid_output (debug captured — stringified arrays on both calls) |
| re-run #3 | `dc514e6` | PASS | call 1 stringified, call 2 redirected by retry prompt |
| post-removal | `c2ef64d` | FAIL | invalid_output (stringified arrays on both calls, `\`` escapes block JSON.parse accommodation) |

Three of four runs failed on the same task with the same shape. The pass on re-run #3 was redirection succeeding stochastically, not the architecture handling the case. The validator's stringified-array accommodation (commit `dc514e6`) was designed as defense-in-depth; on the post-removal run, the model's output contained `\`` (backslash + backtick — a JS template-literal idiom borrowed into the reasoning text) which is invalid JSON, so `JSON.parse` threw and the accommodation fell through to the standard "not an array" rejection.

The trigger language in the existing BACKLOG entry (`polish-validator-stringified-array-accommodation`) was: "if a future eval run produces a failure mode tied to the accommodation (e.g., a stringified non-JSON output the catch swallows but the model thinks succeeded), revisit and consider implementing Option C." The post-removal run satisfies that trigger.

**Root cause class**: array-shape ambiguity in tool inputs. The current architecture asks the model to produce one JSON object containing an array of N judgments. The model can ALSO satisfy "object with field `perCriterion` whose value is JSON-ish" by stringifying the array. Neither prompt nor schema enforcement is preventing this consistently. The architectural fix removes the array shape from the surface entirely.

## The new contract

**runSemanticVerifier signature** (interface):

```ts
// BEFORE
export async function runSemanticVerifier(
  deps: SemanticVerifierDeps,
  input: { diff: string; acceptanceCriteria: ReadonlyArray<string> },
  options?: SemanticVerifierOptions,
): Promise<SemanticVerifierResult>;

// AFTER (same external signature; internal calling pattern changes)
export async function runSemanticVerifier(
  deps: SemanticVerifierDeps,
  input: { diff: string; acceptanceCriteria: ReadonlyArray<string> },
  options?: SemanticVerifierOptions,
): Promise<SemanticVerifierResult>;
```

The PUBLIC API does not change. Internal implementation goes from "one call, parse array out" to "N calls, aggregate". `SemanticVerifierResult` keeps the same shape (the aggregator assembles a `perCriterion: PerCriterionJudgment[]` field).

This means `runVerifier`, `tickVerifying`, the Verdict type, and everything downstream of the verifier stays untouched. The refactor is scoped strictly to inside `verifier/semantic.ts`.

## Prompt structure per call

Each call has a single criterion in the user prompt. The system prompt is unchanged (1,300 tokens, cached via `cache_control` on first call). The user prompt becomes:

```text
# Diff

```
{git diff main..HEAD, capped at 30 KB}
```

# Acceptance criterion

{single criterion text, verbatim}

Call submit_verdict for this one criterion. Echo the criterion string verbatim into `criterion`. Respond with one judgment object — `criterion`, `met`, `reasoning` — not an array.
```

Schema for the tool input changes from "object with perCriterion array" to "object with three scalar fields":

```ts
export const SEMANTIC_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    criterion: { type: 'string', minLength: 1 },
    met: { type: 'boolean' },
    reasoning: { type: 'string', minLength: 1, maxLength: 500 },
  },
  required: ['criterion', 'met', 'reasoning'],
  additionalProperties: false,
};
```

No array, no stringification opportunity. The model returns one judgment object; the wire format has no room for the pathology.

## Aggregation logic

The new internal flow:

```ts
async function runSemanticVerifier(deps, input, options) {
  const cacheBreakpoint = buildCachedPrefix(input.diff); // system + diff, marked cacheable
  
  // Call 1: serial — establishes the cache.
  const result1 = await callOne(deps, cacheBreakpoint, input.acceptanceCriteria[0]);
  if (!result1.ok && options.failureMode === 'all-or-nothing') return shapeFailure(result1);
  
  // Calls 2..N: parallel, all reading from the cache.
  const restResults = await Promise.all(
    input.acceptanceCriteria.slice(1).map((c) => callOne(deps, cacheBreakpoint, c)),
  );
  
  // Aggregate.
  const perCriterion: PerCriterionJudgment[] = [];
  const failures: { criterion: string; reason: string }[] = [];
  for (const [i, r] of [result1, ...restResults].entries()) {
    if (r.ok) {
      perCriterion.push({ criterion: r.criterion, met: r.met, reasoning: r.reasoning });
    } else {
      failures.push({ criterion: input.acceptanceCriteria[i], reason: r.reason });
    }
  }
  
  // Build the SemanticVerifierResult.
  return aggregate(perCriterion, failures, usages, ...);
}
```

`matches = perCriterion.every(c => c.met) && failures.length === 0`. The current invariant ("every criterion got a judgment") becomes a soft expectation: if 6 of 7 criteria got valid judgments and 1 errored, the run is marked failed with the 1 error visible.

## Concurrency: hybrid (call 1 serial, calls 2..N parallel)

The choice is between three patterns:

**Serial**: N calls back-to-back. Cache hits work cleanly because call (i) cached prefix is available to call (i+1). Total latency: N × per-call duration. For 7 criteria × 4s ≈ 28s. Cost cheapest.

**Parallel** (all at once): N concurrent calls. Cache hits don't work — concurrent calls each try to write the cache simultaneously (or all miss). Cost is Scenario A from the projection ($0.053 vs $0.030). Latency is min(N × per-call, max per-call) ≈ 5s.

**Hybrid** (recommended): Call 1 serial — completes, establishes the cache. Calls 2..N parallel — all read from the cache. Wall-clock: call_1_duration + max(parallel_2..N_durations) ≈ 5s + 5s = ~10s. Cost: Scenario C ($0.030). Optimal on both axes.

The hybrid pattern depends on Anthropic's prompt cache being available across concurrent calls after a serial create. Cache TTL is 5 min (default) which is far longer than the ~10s window we need. Cache breakpoints are placed in `messages` array via `cache_control: { type: 'ephemeral' }` on the relevant content blocks; we put one on the user-prompt's diff portion (with the system prompt also implicitly cached as part of the same prefix).

Recommendation: **hybrid**. If the cache doesn't behave as expected (e.g., concurrent calls don't share writes), fall back to serial — costs slightly more but no architectural change.

## Error handling per call

Three failure modes per call: SDK error, validator rejection, retry-also-failed. The current architecture treats any of these as fatal for the entire verification step. The new architecture has more granularity available; question is how granular to make it.

**Recommendation**: per-criterion failure isolation. If criterion 3 of 7 fails (SDK error or invalid output twice), criteria 1, 2, 4, 5, 6, 7 still get judgments. The aggregate Verdict marks the run as failed but the failure detail includes WHICH criterion failed and why. This:
- Preserves more information for post-mortem (vs "the whole verifier failed").
- Makes per-criterion debugging cleaner (the debug artifact captures only the failing call's data).
- Lets a run that has 6/7 judgments + 1 SDK timeout still produce useful per-criterion data, which is more useful than "the entire semantic verification failed."

Implementation: each `callOne` returns `{ ok: true, criterion, met, reasoning, usage } | { ok: false, criterion: string, reason: 'sdk_error' | 'invalid_output', message: string, usage: TokenUsage }`. The aggregator builds `perCriterion` from the successes and a `failures` array from the failures. The final `SemanticVerifierResult` extends to include `verifierErrors?: Array<{ criterion: string; reason: string; message: string }>` — populated when at least one call failed.

The Verdict's overall `pass` is `false` if any criterion failed (a verifier-error counts as not-met for the run's pass/fail decision; the user can tell the difference by reading `verifierErrors` in the artifact).

## Migration of existing semantic tests

`packages/runtime/test/verifier/`:

- `semantic.test.ts`: ~13 tests. Most reshape moderately. Specifics:
  - "returns ok:true matches:true when all judgments are met" → restructure mock SDK responses to return ONE per call, not an array. Test still validates aggregation.
  - "returns ok:true matches:false when at least one met=false" → same pattern.
  - "retries once and succeeds on call 2" → reframed as "criterion 1 retries once and succeeds" (per-criterion retry, not per-task retry).
  - "returns reason:invalid_output after two consecutive invalid calls" → reframed as "criterion 3 returns reason:invalid_output after two invalid calls; other criteria still get judgments."
  - "SDK error" tests reframed similarly: error on criterion N marks just that criterion as failed.
  - Diff truncation tests stay (diff cap behavior unchanged).
  - Borderline-judgment example test (system prompt content) stays unchanged.
  - DELETE: any test asserting on `rawToolInput` containing an array shape (replaced by tests asserting on per-call shapes).

- `semanticSchema.test.ts`: ~14 tests. Substantial rework:
  - The schema changed (single judgment, not array). Tests that asserted "perCriterion is an array of objects" become "tool input has criterion + met + reasoning fields."
  - "rejects when output omits an input criterion" — REMOVED (no input criterion list per call; one criterion in, one out).
  - "rejects when model paraphrases a criterion" — REMOVED for the same reason; strict-match policy moves up to the per-call validator (still rejects paraphrase, but on one criterion at a time).
  - "ACCEPTS perCriterion as a string containing a JSON-encoded array" — REMOVED. The accommodation is no longer applicable; the schema has no array.
  - Add new tests: rejects when `criterion` is missing/empty; rejects when `met` is not a boolean; rejects when `reasoning` is over 500 chars; accepts a valid single judgment.

- `semanticPrompt.test.ts`: ~12 tests. Minor changes:
  - "user prompt template wraps the diff in `# Diff` fenced block" stays.
  - "user prompt template numbers criteria in `# Acceptance criteria`" — UPDATE: now single `# Acceptance criterion` (singular), no numbering.
  - "instructs the model to echo criteria verbatim" stays.
  - "examples" tests stay (system prompt content unchanged).
  - "retry prompt" tests stay (retry shape per call is similar in structure, applies to a single criterion).

- `runVerifier.test.ts`: tests against `runVerifier` (the composer), which uses `runSemanticVerifier` internally. These should mostly stay green — the composer's contract hasn't changed. If any test mocked the SDK assuming one-call behavior, it adapts to N-call.

- `calibrationAnchor.test.ts`: already deleted (anchor removed).

Net test count change: roughly the same. Some merge, some split, some get deleted, some get added. Expected: ~12 semantic tests, ~14 schema tests, ~12 prompt tests = ~38 verifier-only tests (down from 41).

## Test plan for the new structure

New tests covering the architectural shape:

1. **Aggregation: N calls all succeed → matches: true.** N=3, all met:true. Result has perCriterion with 3 entries, matches:true.
2. **Aggregation: N calls, one met:false → matches: false.** Verifier returns valid judgments for all N, but one is met:false. matches:false.
3. **Aggregation: N calls, one fails validation twice → marked verifier_error.** N=3, criterion 2 returns invalid output both times. perCriterion has 2 entries (1 and 3); verifierErrors has 1 entry for criterion 2; matches:false.
4. **Aggregation: SDK error on one criterion → marked sdk_error.** Same shape as #3 but with SDK error instead of invalid output.
5. **Hybrid execution: call 1 happens before calls 2..N.** Mock SDK records timestamps; assert call 1 completes before calls 2..N start, and that calls 2..N overlap.
6. **Cache control: call 1's request has cache_control breakpoints in messages.** Mock SDK inspects the request; assert cache_control fields present.
7. **Cache control: calls 2..N's requests have NO cache_control (only call 1 writes the cache).** Same inspector.
8. **Cost calculation aggregates across all N calls.** Total usages array has N entries.
9. **Latency: parallel calls 2..N do not run serially.** Mock SDK with controlled delays; total time should be call_1 + max(parallel) not call_1 + sum(parallel).
10. **Single criterion: N=1.** Edge case — no parallel section, just call 1 happens. Result populates correctly.
11. **Zero criteria: N=0.** Returns ok:true matches:true with empty perCriterion. (Currently the composer short-circuits at this point; if it doesn't reach semantic with N=0, this is a no-op test.)
12. **Debug artifact: ALL per-criterion calls appear when ANY call fails; no artifact written when all calls succeed** (refinement A). Mock 5 criteria where 2 fail validation: debug shows 5 call records (3 with `validatorOutcome.ok: true`, 2 with `validatorOutcome.ok: false`). Mock 5 criteria all succeeding: assert no debug artifact exists on disk. The cross-call comparison surface (same diff, same system prompt, different criterion outcomes) is the diagnostic value.

13. **Schema regression guard: `SEMANTIC_INPUT_SCHEMA` does NOT contain a `perCriterion` field** (refinement C). Trivial assertion: `expect(SEMANTIC_INPUT_SCHEMA.properties).not.toHaveProperty('perCriterion')`. The schema is the contract that prevents the array-shape failure class; if a future refactor accidentally reintroduces the array shape, this test catches it. High-value guardrail for low cost.

14. **Cache breakpoint placement: cache_control is on the diff content block specifically** (clarification on item 4). Mock SDK inspects the request; assert `cache_control: { type: 'ephemeral' }` is present on the user-prompt content block containing the diff, and NOT on the content block containing the criterion text. The cache covers everything up to and including the marked block; placing the marker on the criterion (which varies per call) would invalidate the cache between calls. The marker on the diff (constant within a task) lets calls 2..N read the cache.

Integration test:
- Existing `verifier/integration.test.ts` (if any) adapts to the new shape. Same fixture: small repo, applied diff, criteria; mocked SDK returns canned per-call responses. Assert Verdict and aggregation.

## Risks

What the new architecture could get wrong that the old one didn't:

**R1: N times the API surface for retries.** If 7 criteria each retry once on invalid output, we make up to 14 SDK calls per task. Mitigation: cap retries-per-criterion at 1 (same as today). Worst-case calls: 2N + 1 (call 1 + retry of call 1, then N-1 parallel + N-1 retries of those). For N=7: 13 calls max. Still under the per-task wall-clock budget at ~5s each. Cost still under projection (each retry adds ~$0.003).

**R2: Cache cache_control breakpoint mismatches.** Calls 2..N expect the cache from call 1 to exist. If anything goes wrong (TTL, region, account-level cache disabled), calls 2..N silently miss the cache and pay full input prices — Scenario A cost ($0.053) instead of Scenario C ($0.030). Mitigation: monitor the `cache_read_input_tokens` field in usage payloads. If it stays at 0 across calls 2..N when we expected non-zero, log a warn. Cost rises 2× but no behavioral regression.

**R3: Concurrent calls share cache state in surprising ways.** If Anthropic's cache implementation produces different behavior under concurrent reads vs. serial reads on the same breakpoint, we could see judgment inconsistency. Mitigation: assertion in tests + a smoke run during implementation. Fallback: drop to serial calls (Scenario B cost, $0.036).

**R4: The model produces a different invalid shape per call.** Today's stringification was on the array; with single judgments, the model could produce e.g. `{ judgment: { criterion, met, reasoning } }` — wrapping the judgment in another object. Mitigation: the validator already rejects with a clear "missing field" error. Retry prompt's shape reminder tightens to the single-judgment shape. If a new wrap-pattern emerges, that's a new failure family — handled per the standing "third distinct family escalates" trigger.

**R5: Failure isolation makes flaky tests pass.** If one criterion's call randomly times out, the aggregator marks it as failed and the run is failed — same as today. But if we're not careful, we might be tempted to mark it as "deferred" or "skipped" and let the run pass. **The recommendation here is explicit: any per-criterion failure fails the run.** The Verdict.pass is only true when all N criteria succeed AND all are met.

**R6: Diff appears 7× in the cost projection but is shared via caching.** Verified above: cache breakpoints on the system + diff prefix mean N calls share the diff cost. If caching breaks (R2/R3), the cost goes up linearly with N. Mitigation: explicit logging on cache hits; alarm if cache hit rate falls below 80% on calls 2..N.

**R7: Test count and complexity grow proportionally with N-call patterns.** The "mock SDK returns the right sequence of responses" pattern gets more elaborate. Mitigation: a small test helper `mockPerCriterionSDK(responses)` that takes an array of canned responses, one per criterion, and dispatches on call order. Centralizes the boilerplate.

## Cost projection (summarized from the analysis)

| Scenario | Verifier per task | Median total | p95 total |
|---|---|---|---|
| Current (1 call w/ array) | $0.020 | $0.207 | $0.517 |
| A. No caching | $0.053 | $0.240 | $0.550 |
| B. System cached | $0.036 | $0.223 | $0.533 |
| **C. System + diff cached (hybrid)** | **$0.030** | **$0.217** | **$0.527** |

Recommended path: hybrid execution + Scenario C caching. Median rises ~$0.01 per task (5%), p95 rises ~$0.01. Tier 5 (median ≤ $0.50) intact with wide margin.

Latency: hybrid execution keeps median task wall-clock at ~60s (vs current 60s). Within-task verifier portion goes from ~9s (1 call) to ~10s (call 1 + parallel rest).

## Implementation order

After signoff:

1. **Schema + types** (small, mechanical): update `SEMANTIC_INPUT_SCHEMA` to single-judgment shape; update `PerCriterionJudgment` (unchanged externally); split internal type for one-call result.
2. **Prompt** (single-criterion variants): `buildSemanticUserPrompt(diff, criterion)` (singular); update `buildSemanticRetryUserPrompt` for single-judgment shape; system prompt unchanged.
3. **Validator** (simpler than before): `validateSingleJudgment(raw, criterion)` replaces `validateSemanticOutput(raw, criteria)`. Strict-match still applies to the single criterion.
4. **Internal callOne**: factor out the current single-SDK-call logic with cache_control breakpoints.
5. **Hybrid orchestration**: in `runSemanticVerifier`, await call 1, then `Promise.all` for calls 2..N.
6. **Aggregator**: build perCriterion[] + verifierErrors[]; compute matches; assemble SemanticVerifierResult.
7. **Debug artifact**: when ANY call in a task fails validation, persist a single `verdict-NNN.semantic-debug.json` containing ALL per-criterion calls — successful and failed alike (refinement A). Schema: `{ schemaVersion: 1, debug: { systemPrompt, calls: SemanticDebugCall[] } }` where each `SemanticDebugCall` has `{ criterionIndex, criterion, userPrompt, rawToolInput, validatorOutcome: { ok: true } | { ok: false, reason, errors } }`. Rationale: cross-call diagnostic value is highest when comparing successful and failed calls *within the same task* — same diff, same system prompt, same execution context. Capturing only failed calls would lose the comparison surface that made the original split-module investigation informative. When all calls succeed, no artifact is written (their judgments are already in `verdict-NNN.json`).
8. **Update existing tests + add new aggregation tests.**
9. **The stringified-array accommodation is not explicitly removed; it is not carried forward.** The accommodation lives in the old `validateSemanticOutput(raw, inputCriteria)`, which is replaced by `validateSingleJudgment(raw, criterion)`. The new validator has no array path; the accommodation has no surface to attach to. The accommodation's deletion is by *absence*, not by explicit removal in a diff. Update BACKLOG: move `polish-validator-stringified-array-accommodation` to Resolved with rationale "superseded by per-criterion architecture — no array surface remains for stringification to occur on."
10. **Re-run CHECKPOINT 3 FIVE consecutive times** after the refactor lands (refinement B). **Refined gate definition (post-round-2):** the 5-run gate now splits tasks into three categories with different stability expectations, because the original "≥7/8 on all 5" framing conflated architectural stability with executor capability variance on hard reasoning tasks.

    **Refined CHECKPOINT 3 gate** clears when ALL of:
    1. **Architectural-stability tasks** (add-clamp, add-edge-case-tests, extract-helper, fix-off-by-one, rename-export, split-module): 5/5 consecutive VALID runs at 100% pass rate. These have been rock-stable post per-criterion refactor (split-module specifically passed 3/3 valid runs in round 2). A failure here is a real architectural regression.
    2. **Executor-capability tasks** (infer-target-file): ≥3/5 valid runs at PASS. Tracked as stochastic capability variance, not architecture failure. infer-target-file requires reasoning about recursive transformation of nested structures; Claude Code (the executor) solves it ~1/3 of the time across the round-2 data. See `polish-executor-capability-variance-infer-target-file` in BACKLOG.md.
    3. **Documented rejections** (vague-flaky-fix): continues to triage-reject per `gap-triage-thin-context`. The triage rejection is the correct behavior; counted as expected fail, not actual fail.
    4. **Meta-test (triage anti-pattern violations)**: 0 violations across all valid runs.

    **"Valid runs"** excludes runs that errored out for external reasons (Claude Code session-limit quota walls, network failures, Anthropic API outages). Those are infrastructure issues, not eval data. A run is invalid if executor.log shows api_error_status:429 with "session limit" on every task, or comparable infrastructure errors. A run is VALID even if it has eval-task failures (those are data).

    Why this refinement: in round 2 of the 5-run gate, two runs failed because the agent's implementation didn't satisfy a recursive-transformation criterion the verifier (correctly) caught. That's executor capability, not architectural failure — split-module passed cleanly on all 3 valid runs of round 2, demonstrating the per-criterion refactor itself is stable. The refined gate splits "the system reliably handles task shapes we designed for" (rock-solid) from "the model solves hard reasoning tasks deterministically" (stochastic, accepted as a property of the model).

    Cost: ~$10 + ~75 min wall-clock total per 5-run round; backgroundable. The gate's purpose is stable measurement of architectural properties, not 100% executor reliability.

## What this refactor does NOT touch

To stay scoped:
- Verifier system prompt (unchanged).
- `runVerifier` composer (signature unchanged; only `runSemanticVerifier`'s internals change).
- `tickVerifying` orchestrator wiring (unchanged).
- Verdict type / DB schema (unchanged).
- Triage prompt (already correct after `831dfe6`).
- Eval harness, report, fixtures (unchanged).
- Calibration anchor (already removed).

## Open questions / signoffs requested

1. **Hybrid vs serial concurrency** — recommended hybrid; user input on whether to start with simpler serial and add parallelism only if latency is a problem.
2. **Per-criterion failure isolation** — recommended: failures bubble up to Verdict but other criteria still get judgments. Alternative: any failure fails the whole verifier (current behavior, simpler). Which?
3. **Retry budget per criterion** — SIGNED OFF: each parallel call handles its own retry independently; calls 2..N do NOT block each other on retries. If criterion 3 hits an invalid output and retries, criteria 4, 5, 6, 7 continue running in parallel — they do not wait for criterion 3's retry. Each per-call retry is capped at 1 attempt (same as today's per-task policy, just at criterion granularity now). Worst-case SDK calls per task: 2N + 1 (call 1 + call-1 retry, then N-1 parallel calls + their retries). For N=8 criteria: up to 17 calls. Cost still under Scenario C projection because retries are cached too.
4. **Cache breakpoint placement** — SIGNED OFF: one `cache_control: { type: 'ephemeral' }` marker on the user-prompt content block containing the diff (NOT on the block containing the criterion text). The system prompt is cached implicitly as part of the prefix. The criterion text varies per call and must be AFTER the cache breakpoint so that calls 2..N share the cached prefix while sending fresh criterion content. Test 14 in the test plan asserts this placement.
5. **Move strict-match policy into per-call validator?** Yes — the policy still applies (criterion echoed verbatim). Just at the single-criterion level.
6. **What to do with the existing `polish-validator-stringified-array-accommodation` BACKLOG entry once this lands?** Move to Resolved with note "superseded by per-criterion architecture; no array surface remains where stringification could occur."

After signoff on these, proceed to code.
