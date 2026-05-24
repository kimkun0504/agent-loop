# Triage ↔ Verifier refactor

Status: proposed (not yet started). Resolves `gap-triage-testcommand-pattern-debt` (P1) and `gap-no-semantic-verification` (gap) in one piece of work. Triggered by CHECKPOINT 3 producing what would have been a third triage-prompt patch in the testCommand-rewriting family.

## Why

Two consecutive checkpoints produced two prompt patches in the same failure family — triage rewriting shell verification commands and getting them wrong:

| Checkpoint | Symptom | Patch |
|---|---|---|
| CP2 | triage produced `git grep -l 'parseDate'` (un-negated); should be `! grep -rE 'parseDate\b'` | added negated-grep guidance + Example C |
| CP3 #1 | triage produced `! git diff --quiet HEAD -- src/file`; should be `git diff --quiet main -- src/` | added git-diff guidance + Example D |
| CP3 #2 | triage produced `... '... ["'].*src/utils["']'` — single quote inside single-quoted shell string, syntax error before grep runs | (NOT patched — this design replaces the patch trajectory) |

The pattern is unmistakable: triage is being asked to author bash verifier commands, and it gets one new family wrong per checkpoint. The third instance (CP3 retry's `split-module`) made the choice clear — either we patch indefinitely, or we change the architecture.

**This document proposes Option C from `BACKLOG#gap-triage-testcommand-pattern-debt`:** split verification authoring from triage. Triage describes *what* to verify in natural language; a new semantic verifier step inside the verifier package decides *whether* the diff meets those criteria.

## The new contract

**Triage promises:**

1. `testCommands` is restricted to a small, documented vocabulary of standard project commands (`npm test`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, etc.). The model picks from the enum; novel shell commands are schema-invalid and rejected before they reach the verifier.
2. `acceptanceCriteria` is natural-language prose. Each criterion is one observable claim about the post-edit repo state. Phrased for human readability AND for an LLM to judge against a diff. Examples:
   - "src/foo.js exports a `clamp` function"
   - "no occurrence of `parseDate` (as a whole word) in src/ or test/"
   - "src/parse-int32.js is unchanged from the initial commit"
   - "at least one new test for the negative-number case in test/parse-int32.test.js"

**Verifier promises:**

1. Runs every `testCommand` from the vocabulary against the worktree. All must exit 0.
2. After test commands pass, runs a semantic verification LLM call: given the diff + the acceptance criteria, produces a structured per-criterion judgment.
3. Returns a `Verdict` where:
   - `pass = (all testCommands exit 0) AND (semanticCheck.matches === true)`
   - `semanticCheck.matches = true` iff every criterion is judged met
   - `semanticCheck.perCriterion` carries the per-criterion judgment + reasoning

If `testCommands` fail, the semantic step is skipped — no LLM call, no extra cost. Fail-closed: a test failure is a failure.

## JSON schema changes for triage output

In `agents/triageSchema.ts`, the `spec.testCommands` schema changes from a free-form string array to an enum array.

**Before:**

```json
"testCommands": {
  "type": "array",
  "minItems": 1,
  "items": { "type": "string" }
}
```

**After:**

```json
"testCommands": {
  "type": "array",
  "minItems": 0,
  "maxItems": 5,
  "items": {
    "type": "string",
    "enum": [
      "npm test",
      "npm run typecheck",
      "npm run lint",
      "npm run build",
      "pnpm test",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm build"
    ]
  }
}
```

**`minItems: 0`** — a task with no runnable test command is acceptable as long as it has `acceptanceCriteria`. The semantic verifier handles those. (Today's tasks all have `npm test`; this is forward-compat for repos without a test target.)

**Vocabulary scope:** JS/TS only for Week 3. Adding language support means adding entries here (deliberate, reviewable change). Documented as a known limitation in the prompt and in BACKLOG (will land alongside).

Hand-rolled validator (`triageValidate.ts`) gains a matching `VALID_TEST_COMMANDS` constant. Out-of-vocabulary commands → validator error → triage retries with feedback → if still invalid, rejection with `reason: 'invalid_output'` (existing path).

**The triage system prompt** loses the negated-grep / git-diff / shell-quoting guidance (no longer authoring those commands) and gains:
- Explicit statement that testCommands is a restricted enum
- Guidance that file-state assertions (no-X-remains, don't-touch-Y, file-Z-exists) go in `acceptanceCriteria` as natural language
- A new Example showing this — a rename task with `testCommands: ["npm test"]` and `acceptanceCriteria` carrying the absence claim

Examples C and D from the current prompt are removed (their absence/diff command patterns are now the semantic verifier's job).

## The new semantic verifier step

### Location and shape

Lives in `packages/runtime/src/verifier/semantic.ts`. **Not a new top-level agent — internal to the verifier package** per your constraint. `verifier/exitCode.ts` becomes a private detail; the new top-level export is `runVerifier(run, spec, opts)` which:

1. Calls the exit-code helper internally (existing logic).
2. If all test commands pass, calls `runSemanticVerifier(diff, criteria, opts)` and merges the result.
3. Returns the combined `Verdict`.

No new state-machine phase. `tickVerifying` keeps calling `deps.verifier(...)`; only the implementation behind that function pointer changes.

### Inputs

```ts
interface SemanticVerifierInput {
  diff: string;              // `git diff main` from the worktree, capped
  acceptanceCriteria: string[];
  fileScope?: string[];      // for tighter context (optional)
}
```

The diff is the load-bearing input. Cap at 30 KB to match the planner's content budget. If the diff exceeds the cap, include the full file list + truncated content with a `[truncated]` marker (same pattern as `agents/repoContext.ts::collectFileContents`).

### Model and pricing

**Sonnet 4.6**, matching the planner's tier per your direction. Reuse `SONNET_PRICING` from `agents/planner.ts` (worth hoisting into a shared `agents/pricing.ts` constant in the same commit).

### Tool schema

Force-call `submit_verdict` with this input shape:

```json
{
  "type": "object",
  "properties": {
    "perCriterion": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "criterion": { "type": "string" },
          "met":       { "type": "boolean" },
          "reasoning": { "type": "string", "maxLength": 500 }
        },
        "required": ["criterion", "met", "reasoning"]
      }
    }
  },
  "required": ["perCriterion"]
}
```

`matches` is derived: `perCriterion.every(c => c.met)`. We do NOT ask the model for the overall verdict directly — the discipline is that the model judges each criterion in isolation, and we aggregate. Less rubber-stamping.

### Prompt strategy (high-level)

System prompt principles:
- Role: "You verify whether an agent's diff satisfies a list of acceptance criteria, one criterion at a time."
- Bias toward strictness: "When in doubt, mark `met: false`. A false-negative (asking a human to re-check) is cheaper than a false-positive (merging a wrong fix)." This is the calibration lever — see Risks.
- Output format: forced tool call.
- Examples: 2 worked pairs covering (a) clean pass on a simple change, (b) honest rejection of a diff that misses a criterion. Examples MUST have `met: false` cases — they teach the model to actually fail criteria, not rubber-stamp.

User prompt structure:
- `# Diff` block with the full `git diff main` (capped)
- `# Acceptance criteria` numbered list
- Instruction: "Call submit_verdict, judging each criterion independently."

### Output validation

Hand-rolled `validateSemanticOutput(raw)`:
- `perCriterion` is a non-empty array
- Each entry has all three fields, with non-empty `criterion` + `reasoning`, boolean `met`
- The set of `criterion` strings should match the input criteria. Slight permissiveness: case-insensitive whitespace-normalized match. If a criterion is missing from output, validator fails.

### Retry policy

Same as triage/planner: 1 retry on invalid output, with feedback inlined. Two consecutive invalids → return a synthesized "matches: false, reasoning: 'semantic verifier produced invalid output twice'" judgment. Conservative — better to fail a run than to mark it pass on unparseable output.

### SDK error policy

**Fail-closed for the eval suite, fail-open opt-in for production.**

- Default behavior: if the SDK throws (network, rate limit), the verdict is marked `pass: false` with `semanticCheck.matches: false` and reasoning explaining the SDK error. Run lands in `failed` with category `transient`.
- Opt-out: `VerifyOptions.semanticOnSdkError?: 'fail-closed' | 'pass-with-warning'`. Default `fail-closed`. Production CLI may flip to `pass-with-warning` later, but eval suite stays strict.

### Cost expectation

Per call:
- Input: ~10–30 KB (diff + criteria + system prompt with cache) ≈ 3–8K input tokens
- Output: ~1 KB (per-criterion judgments) ≈ 250 output tokens
- Sonnet pricing: 5K × $3/M + 250 × $15/M ≈ **$0.019** (uncached) → ~$0.009 with the cached system prompt

Per task (one semantic check at end): $0.01–$0.02.

For 8 eval tasks: **+$0.10–0.20** total. Updated p50 task cost estimate: $0.24 → $0.26. Still well under Tier 5's $0.50 target.

The semantic check only runs if exit-code tests pass — failing-exit-code runs (e.g., `vague-flaky-fix`'s rejection at triage) cost nothing extra.

### Budget enforcement

The verifier now consumes tokens, so it must record them. Two paths:

**Path A (recommended):** verifier returns `usages: TokenUsage[]` in its result; `tick.ts::tickVerifying` applies `record_token_usage` events for each entry. Symmetric with how the executor's usage is recorded but kept off the verifier's hot path (verifier stays a function of inputs + deps, no orchestrator coupling).

**Path B:** verifier takes `store + runId` and applies events itself. Symmetric with triage/planner. Tighter coupling; less symmetric with executor.

I prefer Path A — the verifier already returns a structured result; adding `usages` is one more field. Caller applies events; budget check runs after, same as the existing `tickVerifying` will gain.

Budget check pattern in `tickVerifying` mirrors `tickPlanning`: after applying usage events, check `Run.tokensSpent` against `spec.budget.maxTokens`. Over budget → `verification_failed` with category `budget_exceeded`.

## Migration: which `expected.json` files change

Of the 8 eval tasks, **5 need migration** (the ones with non-vocabulary `testCommands`):

| Task | Old testCommands | New testCommands | acceptanceCriteria additions |
|---|---|---|---|
| `extract-helper` | `["npm test", "git diff --quiet main -- test/"]` | `["npm test"]` | "test files test/validate.test.js and test/normalize.test.js are unchanged from the initial commit" |
| `rename-export` | `["npm test", "! grep -rE 'parseDate\\b' src/ test/"]` | `["npm test"]` | "no occurrence of the token `parseDate` (as a whole word) in src/ or test/" |
| `add-edge-case-tests` | `["npm test", "git diff --quiet main -- src/"]` | `["npm test"]` | "src/parse-int32.js is unchanged from the initial commit" |
| `split-module` | `["npm test", "test ! -f src/utils.js", "test -f src/utils/parse.js", "test -f src/utils/format.js"]` | `["npm test"]` | "src/utils.js no longer exists" + "src/utils/parse.js exists and exports parseUrl" + "src/utils/format.js exists and exports formatUrl" |
| `add-clamp` | `["npm test", "grep -rE \"clamp\\(\" test/ > /dev/null"]` | `["npm test"]` | "at least one test for clamp exists in test/" (already an acceptance criterion — testCommand becomes redundant) |

**3 unchanged** (already simple): `fix-off-by-one`, `vague-flaky-fix`, `infer-target-file` — already use only `npm test`.

Migration is a single doc-only commit: edit 5 expected.json files. No code changes needed in the eval runner (it just reads the strings and passes them through).

## Risks + calibration

**Risk 1: rubber-stamping (false positives).** The semantic verifier passes a diff that doesn't actually meet a criterion.

Mitigations:
- Prompt biases toward strictness ("when in doubt, mark not met").
- Examples in the system prompt include `met: false` cases.
- Per-criterion judgment forces the model to consider each claim separately rather than summarizing a vibe.
- **Calibration anchor**: keep the old `testCommands` for the 5 migrated tasks as a side-channel comparison during the refactor. If the semantic verifier marks a run as passing AND any of the (now-deprecated) shell test commands would have failed, log the disagreement and treat it as a calibration miss to investigate. This anchor lives in code only during the refactor; remove in a follow-up.

**Risk 2: over-strictness (false negatives).** The semantic verifier rejects a diff that actually meets the criterion (e.g., interprets "unchanged" too literally and rejects formatting whitespace).

Mitigations:
- Reasoning field on every per-criterion judgment makes a wrong rejection inspectable.
- Acceptance criteria phrased concretely (e.g., "no functional change to src/parse-int32.js" rather than "src/parse-int32.js is exactly identical to its initial commit").
- Per-checkpoint review of failed runs — if a calibration miss is a false negative, edit the prompt OR the criterion's wording.

**Risk 3: cost blowup from over-large diffs.** A 30 KB cap on the diff input handles most cases; pathological tasks (massive refactors) get truncated.

Mitigations:
- Diff cap at 30 KB; truncation marker.
- If diff is truncated, semantic verifier is told and may opt to mark `met: false` for criteria it can't evaluate. Better to defer than to guess.

**Risk 4: model drift.** Sonnet's judgment shifts over time; calibration done today may not hold in 6 months.

Mitigations:
- Pin SDK version (already in place: `@anthropic-ai/sdk@0.98.0`).
- Pin Sonnet model id explicitly in the constant.
- Eval suite per-commit comparison: if pass rate shifts > 10 pp without a code change, investigate.

**Calibration story summary:** the calibration is empirical, not theoretical. The new verifier ships with the old shell testCommands kept as side-channel anchors in a temporary calibration mode. We run CHECKPOINT 3 several times under the new architecture; if pass rate matches the old approach (or beats it) AND the calibration anchor catches no false positives, we trust the new verifier and remove the anchor. If we catch false positives, we iterate the prompt or fall back. **No declaration of "the semantic verifier is correct" without empirical data.**

## Tests

New unit tests in `packages/runtime/test/verifier/`:

- `semanticPrompt.test.ts` (~6 tests): system prompt contains role + bias-toward-strictness + per-criterion-independence; user prompt structure for diff + criteria blocks; retry prompt inlines validator errors.
- `semanticSchema.test.ts` (~10 tests): validator accepts valid output; rejects missing perCriterion; rejects missing criterion/met/reasoning; rejects empty reasoning; rejects when output criteria don't cover input criteria.
- `semantic.test.ts` (~10 tests): runSemanticVerifier with mocked SDK — happy all-met, mixed pass/fail, retry on invalid output, SDK error → fail-closed default, calibration-anchor side-channel agreement check.
- `verifier/exitCode.test.ts` (existing 15 tests): updated to confirm the new combined `runVerifier` runs the exit-code path AND the semantic path; semantic skipped when exit-code fails.

Integration test (new):
- `verifier/integration.test.ts`: small fixture repo + diff + criteria, mocked SDK returns canned judgments; assert Verdict shape and Verdict.pass aggregation rules.

Tests stay mocked-SDK; no live LLM in CI. The calibration story plays out in the eval suite, not unit tests.

## Cost + budget implications

Per-task cost delta (vs current CHECKPOINT 3):
- Triage: unchanged (~$0.005)
- Planner: unchanged (~$0.017)
- Executor: unchanged (~$0.15)
- **Verifier (semantic): NEW, ~$0.01–0.02 per task that reaches semantic verification**

Updated cost expectation per task: $0.20 → $0.23 (median). Tier 5 target ($0.50) intact.

Budget enforcement:
- `tickVerifying` applies `record_token_usage` events for the verifier's usages (per Path A above).
- After applying, calls `checkTokenBudget(deps, updatedRun, spec)`. Over budget → `verification_failed` with category `budget_exceeded`. Same pattern as `tickPlanning`.

## Implementation order

1. **Plan signoff** (this document).
2. **agents/pricing.ts** — hoist `HAIKU_PRICING` + `SONNET_PRICING` to a shared constant. Single commit, low risk.
3. **verifier/semantic.ts** — new module: `runSemanticVerifier`, prompt + schema + validator. Mocked-SDK tests. Single commit.
4. **verifier/exitCode.ts → verifier/index.ts** — new top-level `runVerifier` that composes exit-code + semantic. Existing `runExitCodeVerifier` becomes a private detail (or stays exported for tests). Update tests.
5. **agents/triageSchema.ts + triageValidate.ts** — enum-restrict `testCommands`. Drop the absence/diff/shell-quoting guidance from the system prompt; add the "use acceptanceCriteria for file-state claims" guidance + new Example C (replacing the old Examples C and D).
6. **runtime/orchestrator/tick.ts** — `tickVerifying` applies verifier's `usages` events + cross-phase budget check.
7. **core types** — extend `Verdict.semanticCheck` with optional `perCriterion` field. Existing serialization stays compatible (row converter handles missing field).
8. **Eval task migration** — single docs/data commit updating the 5 expected.json files (extract-helper, rename-export, add-edge-case-tests, split-module, add-clamp).
9. **Calibration anchor** — temporary side-channel comparison: keep the OLD testCommands in a `expected.json.calibrationTestCommands` field, run them alongside the new flow during eval runs, log disagreements. Single commit, behind a flag.
10. **Re-run CHECKPOINT 3** — must hit ≥7/8 to proceed to Phase F (per your stated gate). Investigate any calibration disagreements.
11. **Remove the calibration anchor** in a follow-up commit once we've trusted the new verifier across one or two eval cycles.

Estimated work: 2–3 sessions for steps 2–9; one CHECKPOINT 3 re-run; removal of anchor is a separate later commit. Multi-commit; conventional commit format throughout; each step tests + typechecks before commit.

## Open questions / signoffs requested

1. **Restricted testCommand vocabulary**: starting set is `npm test|run typecheck|run lint|run build` + `pnpm test|typecheck|lint|build`. OK to ship with that or do you want to add `vitest`, `jest`, `tsc --noEmit`, etc.? My preference: keep starting set minimal; add entries as concrete needs surface. Out-of-vocab triage outputs fail validation and the model retries → eventually we'll see what's actually missing.

2. **Calibration anchor**: I'm proposing keeping the OLD shell testCommands in a `calibrationTestCommands` field on `expected.json` (a new field, only read by the eval runner during the calibration window). Alternative: don't keep them at all, trust the semantic verifier from day one. My preference: keep the anchor through one eval cycle to validate; removal in a follow-up commit is a one-line delete.

3. **SDK-error default**: fail-closed for eval, opt-in fail-open for production. OK?

4. **Verdict.semanticCheck.perCriterion field**: new optional field on the Verdict type — existing rows in the DB stay valid (field is absent). OK?

5. **Pricing constants hoisting**: `agents/pricing.ts` as a single source. Existing `HAIKU_PRICING` + `SONNET_PRICING` move out of their respective agent files. Trivial refactor; included here so it's not surprise scope-creep in a later commit.

6. **Examples in the semantic verifier prompt**: I'm proposing 2 worked examples — one all-met pass, one with a `met: false` rejection. Should I pull these from the eval task set (risk of overfitting to those exact tasks) or write fresh ones (more text in the system prompt)? My preference: fresh ones, drawn from non-eval domains, same approach as the triage/planner prompt examples.

7. **Should triage be informed about the vocabulary explicitly in the prompt OR only via the schema?** Both, ideally — schema enforces; prompt guides. Confirming I should add the explicit vocabulary list to the system prompt with rationale ("these are the runnable commands the verifier supports; anything else, put in acceptanceCriteria").

Once signed off, I'll begin at step 2 (pricing hoisting) and proceed through 9; CHECKPOINT 3 re-run is the gate before Phase F starts.
