# Triage ↔ Verifier refactor

Status: signed off (2026-05-24). Resolves `gap-triage-testcommand-pattern-debt` (P1) and `gap-no-semantic-verification` (gap) in one piece of work. Triggered by CHECKPOINT 3 producing what would have been a third triage-prompt patch in the testCommand-rewriting family.

## Summary

Elevator pitch for future reviewers. The rest of the doc is reference.

- **Triage now produces:** specs whose `testCommands` are picked from a fixed enum (`npm test`, `pnpm test`, `pnpm typecheck`, etc.) — no shell authoring — plus `acceptanceCriteria` written in natural language as observable claims about post-edit repo state (file existence, absence of a token, "X is unchanged", etc.).
- **The verifier now does:** runs every `testCommand` (exit-code check, existing behavior), then if those pass, calls a new internal `runSemanticVerifier` step — Sonnet 4.6, mocked-SDK-testable — that judges each acceptance criterion against the diff one-at-a-time. Verdict.pass = both gates pass. Not a new state-machine phase; lives inside the verifier package.
- **The eval report now shows:** the existing per-task pass/fail/cost lines, plus a new "Calibration disagreements: N/M" line that surfaces every case where the side-channel calibration anchor (kept shell testCommands) disagrees with the semantic verifier. Each disagreement is logged warn-level with the anchor's specific commands, exit codes, and an "Investigate:" prompt line. Semantic verdict is authoritative; anchor is signal only.
- **The calibration anchor is removed when:** one full eval suite run shows zero anchor/semantic disagreements. Not on a timer. Tracked as `gap-calibration-anchor-removal` with an explicit halt condition if disagreements persist across iterations.
- **Cost change:** +$0.01–0.02 per task that reaches semantic verification (Sonnet call on the diff). Median task cost $0.20 → $0.23. Tier 5 budget ($0.50) intact.

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
- **An anti-pattern list** with one entry to start: "Do NOT produce acceptance criteria that are exit-code checks. Anything that reads like 'X exits 0' or 'command Y succeeds' belongs in `testCommands`, not `acceptanceCriteria`. The semantic verifier judges criteria against the diff, not by running shell commands; an exit-code-shaped criterion is invisible to it." We do NOT add an `inapplicable` disposition to the semantic verifier schema — silent ambiguity becomes an anti-pattern at the source instead. Revisit if such criteria leak through anyway.

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

### Prompt structure

Full system prompt text (lives in `packages/runtime/src/verifier/semanticPrompt.ts`):

```text
You verify whether an agent's code diff satisfies a list of acceptance criteria. You judge ONE criterion at a time, against the diff. You respond by calling the `submit_verdict` tool with a per-criterion judgment.

# Your bias

When in doubt, mark `met: false`. A false negative (asking a human to re-check) is recoverable. A false positive (passing a wrong fix) compounds: it merges, and the next agent run inherits the broken state.

# How to judge each criterion

For each criterion in the input list:
1. Read the criterion as a single observable claim about the post-edit repo state.
2. Locate the evidence in the diff. If you cannot find evidence in the diff, treat the criterion as unmet — the diff IS the universe of changes for this judgment. You do not have access to the pre-edit code outside what the diff shows.
3. Record your judgment in `perCriterion[i]`:
   - `criterion`: the exact criterion text from the input (verbatim — do not paraphrase, do not rewrite, do not normalize. Echo the string as given).
   - `met`: boolean. `true` only if you can point to specific diff evidence.
   - `reasoning`: one-to-three sentences citing the specific hunk or line that drove your judgment. Quote line content if it disambiguates. If `met: false`, say what specifically is missing or wrong.

If a criterion describes a state OUTSIDE the diff (e.g., "src/foo.js is unchanged from the initial commit"): the diff is the universe of changes. If the diff contains no hunks touching that path, the criterion is met. If it does, the criterion is not met.

# Two worked examples

## Example 1 — mixed: one met, one met:false (borderline)

Diff:
\`\`\`
diff --git a/src/parse.js b/src/parse.js
+export function parseAge(s) {
+  const n = Number(s);
+  if (Number.isNaN(n)) return null;
+  return n;
+}
\`\`\`

Criteria:
1. parseAge is exported from src/parse.js
2. parseAge throws on non-numeric input

Tool call:
{
  "perCriterion": [
    { "criterion": "parseAge is exported from src/parse.js", "met": true,
      "reasoning": "The added hunk in src/parse.js contains `export function parseAge(s)`, satisfying the export claim directly." },
    { "criterion": "parseAge throws on non-numeric input", "met": false,
      "reasoning": "The added function returns `null` on non-numeric input via `if (Number.isNaN(n)) return null` — it does not throw. The criterion explicitly requires throwing, so returning null does not satisfy it even though the function does distinguish the invalid case." }
  ]
}

Note the second judgment: the function ALMOST satisfies the criterion (it handles invalid input), but the specific verb in the criterion is "throws" and the diff shows "returns null". That gap tips the judgment to met:false. This is the depth of reading required — read the verb, not the vibe.

Note: deletion hunks count as "touching" a path. A criterion of "src/foo.js is unchanged" is NOT met if the diff contains a deletion or rename of src/foo.js. A pure rename or file delete is a change to the path.

## Example 2 — clean pass on a path-untouched criterion

Diff:
\`\`\`
diff --git a/test/parse.test.js b/test/parse.test.js
+test('parseAge handles negative numbers', () => { ... });
\`\`\`

Criteria:
1. test/parse.test.js contains a new test for negative numbers
2. src/parse.js is unchanged from the initial commit

Tool call:
{
  "perCriterion": [
    { "criterion": "test/parse.test.js contains a new test for negative numbers", "met": true,
      "reasoning": "Added hunk in test/parse.test.js adds a test titled 'parseAge handles negative numbers'." },
    { "criterion": "src/parse.js is unchanged from the initial commit", "met": true,
      "reasoning": "No diff hunks touch src/parse.js (no additions, no deletions, no renames). Since the diff is the universe of changes, absence of any hunk for that path means the file is unchanged." }
  ]
}

# Format

Always call `submit_verdict`. Never respond with prose. The tool input shape is enforced.
```

User prompt template:

```text
# Diff

```
{git diff main, capped at 30 KB. If truncated, append `[truncated: N more KB]` and a `[files truncated:]` list}
```

# Acceptance criteria

1. {criterion 1 verbatim}
2. {criterion 2 verbatim}
...

Call submit_verdict, judging each criterion independently. Echo each criterion string verbatim into your output's `criterion` field.
```

Retry prompt template (on validator failure): original user prompt + the validator's error list inlined as a `# Your previous response had validation errors` block — same shape as the existing triage/planner retry path.

### Output validation

Hand-rolled `validateSemanticOutput(raw, inputCriteria)`:
- `perCriterion` is a non-empty array
- Each entry has all three fields, with non-empty `criterion` + `reasoning`, boolean `met`
- `reasoning` is at most 500 characters
- **The set of `criterion` strings must match the input criteria exactly, after normalizing whitespace and stripping trailing punctuation.** Paraphrase is rejected. Case-sensitive (acceptance criteria are written by triage and copied through verbatim — there is no human re-typing them). The retry prompt instructs the model: "echo each criterion string verbatim; do not paraphrase, do not normalize."
- Output may reorder criteria from input (the model picks judgment order); ordering is unenforced.

The strict-match rule is load-bearing: a paraphrased criterion is a paraphrased *judgment*, and the human reviewer downstream has to mentally re-bind the paraphrase to the original — which is exactly the failure mode where rubber-stamping hides. Regression test in `semanticSchema.test.ts` enforces (refinement H below).

### Retry policy

Same as triage/planner: 1 retry on invalid output, with feedback inlined. Two consecutive invalids → return a synthesized "matches: false, reasoning: 'semantic verifier produced invalid output twice'" judgment. Conservative — better to fail a run than to mark it pass on unparseable output.

### SDK error policy

**Fail-closed by default. In every mode. Opt-in only.**

- Default behavior (eval AND production): if the SDK throws (network, rate limit), the verdict is marked `pass: false` with `semanticCheck.matches: false` and reasoning explaining the SDK error. Run lands in `failed` with category `transient`.
- Opt-in opt-out: CLI flag `--semantic-verification-on-error <strict|skip>`, default `strict`. Plumbed through as `VerifyOptions.semanticOnSdkError`. `strict` = fail-closed (default). `skip` = mark semantic step as skipped, accept exit-code-only verdict, log a warning. **The opt-in must be typed explicitly per invocation** — there is no env-var or config-file equivalent. We don't want a forgotten dotfile silently downgrading the verifier.
- Eval suite ignores the flag and is hard-coded to `strict`. Eval can't drift loose.

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

Of the 8 eval tasks, **5 need migration** (the ones with non-vocabulary `testCommands`). Each table cell below is the FULL new file content (not a fragment); `calibrationTestCommands` retains the OLD shell commands for the side-channel anchor (see §"Calibration-anchor disagreement policy").

**3 unchanged** (already simple): `fix-off-by-one`, `vague-flaky-fix`, `infer-target-file` — already use only `npm test`.

### `evals/tasks/extract-helper/expected.json`

Old:
```json
{
  "acceptanceCriteria": [
    "isValidUrl is defined exactly once in src/ (no longer duplicated)",
    "both validate.js and normalize.js use the shared helper",
    "test/validate.test.js and test/normalize.test.js are unchanged",
    "npm test still passes"
  ],
  "testCommands": ["npm test", "git diff --quiet main -- test/"]
}
```

New:
```json
{
  "acceptanceCriteria": [
    "isValidUrl is defined exactly once in src/ (no longer duplicated)",
    "both validate.js and normalize.js use the shared helper",
    "test/validate.test.js is unchanged from the initial commit",
    "test/normalize.test.js is unchanged from the initial commit",
    "npm test still passes"
  ],
  "testCommands": ["npm test"],
  "calibrationTestCommands": ["git diff --quiet main -- test/"]
}
```

Why: split the "test/ unchanged" claim into per-file criteria so the semantic verifier judges each independently — fewer ambiguous partial-pass cases.

### `evals/tasks/rename-export/expected.json`

Old:
```json
{
  "acceptanceCriteria": [
    "parseIsoDate exported from src/date.js",
    "src/format.js imports and uses parseIsoDate",
    "test/format.test.js imports and uses parseIsoDate",
    "no occurrence of the old name parseDate (as a whole word) anywhere under src/ or test/",
    "npm test still passes"
  ],
  "testCommands": ["npm test", "! grep -rE 'parseDate\\b' src/ test/"]
}
```

New:
```json
{
  "acceptanceCriteria": [
    "parseIsoDate exported from src/date.js",
    "src/format.js imports and uses parseIsoDate",
    "test/format.test.js imports and uses parseIsoDate",
    "no occurrence of the token parseDate (as a whole word) remains anywhere under src/ or test/",
    "npm test still passes"
  ],
  "testCommands": ["npm test"],
  "calibrationTestCommands": ["! grep -rE 'parseDate\\b' src/ test/"]
}
```

Why: tightened wording — "token … (as a whole word) remains" cues the semantic verifier that this is an exhaustive absence check.

### `evals/tasks/add-edge-case-tests/expected.json`

Old:
```json
{
  "acceptanceCriteria": [
    "new tests cover negative numbers (e.g., parseInt32('-42') === -42)",
    "new tests cover whitespace (e.g., parseInt32('  42  ') === 42)",
    "new tests cover INT32 boundaries: parseInt32('-2147483648') and parseInt32('2147483647') succeed",
    "new tests assert that overflow throws RangeError (e.g., parseInt32('2147483648'))",
    "new tests assert that non-numeric input throws (e.g., parseInt32('abc'))",
    "src/parse-int32.js has NOT been modified",
    "all tests pass"
  ],
  "testCommands": ["npm test", "git diff --quiet main -- src/"]
}
```

New:
```json
{
  "acceptanceCriteria": [
    "new tests cover negative numbers (e.g., parseInt32('-42') === -42)",
    "new tests cover whitespace (e.g., parseInt32('  42  ') === 42)",
    "new tests cover INT32 boundaries: parseInt32('-2147483648') and parseInt32('2147483647') succeed",
    "new tests assert that overflow throws RangeError (e.g., parseInt32('2147483648'))",
    "new tests assert that non-numeric input throws (e.g., parseInt32('abc'))",
    "src/parse-int32.js is unchanged from the initial commit (no hunks touching that path)",
    "all tests pass"
  ],
  "testCommands": ["npm test"],
  "calibrationTestCommands": ["git diff --quiet main -- src/"]
}
```

Why: "(no hunks touching that path)" invokes the diff-is-universe-of-changes guidance from the system prompt's Example 2 — closes the rubber-stamping door for the criterion most at risk of false positive.

### `evals/tasks/split-module/expected.json`

Old:
```json
{
  "acceptanceCriteria": [
    "src/utils/parse.js exists and exports parseUrl",
    "src/utils/format.js exists and exports formatUrl",
    "src/utils.js no longer exists",
    "src/api.js imports parseUrl from src/utils/parse.js and formatUrl from src/utils/format.js",
    "test/utils.test.js imports from the new locations",
    "all tests pass"
  ],
  "testCommands": [
    "npm test",
    "test ! -f src/utils.js",
    "test -f src/utils/parse.js",
    "test -f src/utils/format.js"
  ]
}
```

New:
```json
{
  "acceptanceCriteria": [
    "src/utils/parse.js exists and exports parseUrl",
    "src/utils/format.js exists and exports formatUrl",
    "src/utils.js has been deleted (the diff contains a deletion hunk for src/utils.js)",
    "src/api.js imports parseUrl from src/utils/parse.js and formatUrl from src/utils/format.js",
    "test/utils.test.js imports parseUrl from the new location src/utils/parse.js",
    "test/utils.test.js imports formatUrl from the new location src/utils/format.js",
    "all tests pass"
  ],
  "testCommands": ["npm test"],
  "calibrationTestCommands": [
    "test ! -f src/utils.js",
    "test -f src/utils/parse.js",
    "test -f src/utils/format.js"
  ]
}
```

Why:
- "no longer exists" → "has been deleted (the diff contains a deletion hunk for src/utils.js)" gives the semantic verifier the specific evidence to look for. This is the task that produced CHECKPOINT 3's bash-quote syntax error — the wording change is precisely what makes the case unambiguous.
- The single import claim is split into two per-import criteria (refinement E). Marginal precision: now a partial migration (one import updated, one missed) fails one criterion rather than the whole import claim being ambiguous.

### `evals/tasks/add-clamp/expected.json`

Old:
```json
{
  "acceptanceCriteria": [
    "clamp is exported from src/math.js",
    "clamp(5, 0, 10) === 5 (value in range, returned unchanged)",
    "clamp(-3, 0, 10) === 0 (value below min, returned as min)",
    "clamp(99, 0, 10) === 10 (value above max, returned as max)",
    "at least one test for clamp exists in test/",
    "existing multiply test still passes"
  ],
  "testCommands": ["npm test", "grep -rE \"clamp\\(\" test/ > /dev/null"]
}
```

New:
```json
{
  "acceptanceCriteria": [
    "clamp is exported from src/math.js",
    "the diff contains a test that asserts clamp(5, 0, 10) returns 5 (a value in the range, unchanged) in a test file under test/",
    "the diff contains a test that asserts clamp(-3, 0, 10) returns 0 (a value below min, returned as min) in a test file under test/",
    "the diff contains a test that asserts clamp(99, 0, 10) returns 10 (a value above max, returned as max) in a test file under test/",
    "existing multiply test still passes (no hunks remove or modify the multiply test)"
  ],
  "testCommands": ["npm test"],
  "calibrationTestCommands": ["grep -rE \"clamp\\(\" test/ > /dev/null"]
}
```

Why:
- "clamp(5, 0, 10) === 5" rewritten to "asserts clamp(5, 0, 10) returns 5" — assertion-pattern-agnostic (refinement D). The old wording would arguably exclude `assert.strictEqual(clamp(5, 0, 10), 5)` (the idiomatic `node:test` form) since that doesn't contain a literal `===` token; the new wording binds to the assertion's *meaning*, not its syntax.
- The "at least one test for clamp exists" criterion is dropped — redundant with the three specific-assertion criteria, which are strictly stronger.
- Each behavioral assertion is bound to diff evidence ("the diff contains") to prevent the verifier from passing a criterion based on it being a true mathematical claim about clamp.

Migration is a single docs/data commit: edit 5 expected.json files. The eval runner gains code (step 9 in implementation order) to read `calibrationTestCommands` and run them via the anchor mechanism.

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

**Calibration story summary:** the calibration is empirical, not theoretical. The new verifier ships with the old shell testCommands kept as side-channel anchors in a temporary calibration mode. We run CHECKPOINT 3 several times under the new architecture; if pass rate matches the old approach (or beats it) AND the calibration anchor catches no disagreements, we trust the new verifier and remove the anchor. If we catch disagreements, we iterate the prompt or fall back. **No declaration of "the semantic verifier is correct" without empirical data.**

### Calibration-anchor disagreement policy

When the anchor disagrees with the semantic verifier on a given run, the **semantic verifier's decision is authoritative** for the run's pass/fail and for the verdict written to the DB. The anchor produces signal, not blocking. Specifically:

| Anchor result | Semantic result | Run outcome | Side effects |
|---|---|---|---|
| pass | pass | pass | no log |
| fail | fail | fail | no log (agreement) |
| pass | fail | **fail** (per semantic) | warn-level log, surfaced in eval report |
| fail | pass | **pass** (per semantic) | warn-level log, surfaced in eval report — this is the false-positive risk we most need to see |

The anchor's exit-code result is recorded alongside the verdict in the per-run artifact (`verdict-NNN.json` gains an optional `calibrationAnchor: { commands: [...], exitCodes: [...], agreement: boolean }` block).

### Eval report format

The eval report (markdown summary written by `cli/src/eval/report.ts`) gets a new top-level section:

```
## Calibration disagreements

N/M tasks disagreed.

- add-edge-case-tests: anchor=fail, semantic=pass (potential false positive)
  Anchor commands:
    - `git diff --quiet main -- src/` → exit 1
  Semantic verdict: matches=true (all 7 criteria judged met)
  Investigate: open verdict-001.json + executor.log for run <runId>. Re-read the "src/parse-int32.js is unchanged" judgment's reasoning. If reasoning cites a hunk that touches src/parse-int32.js, the verifier missed it (rubber-stamp). If reasoning correctly states no hunks touch src/parse-int32.js, the anchor is over-strict (false fail) — likely git showing whitespace or noise from the executor's commit.

- split-module: anchor=pass, semantic=fail (potential false negative)
  Anchor commands:
    - `test ! -f src/utils.js` → exit 0
    - `test -f src/utils/parse.js` → exit 0
    - `test -f src/utils/format.js` → exit 0
  Semantic verdict: matches=false (criterion "test/utils.test.js imports parseUrl from the new location" judged met:false)
  Investigate: re-read the criterion's reasoning in verdict-001.json. If reasoning is wrong about the diff, the verifier is over-strict (refine prompt). If reasoning is correct, the criterion was actually unmet and the anchor missed it (anchor was too weak — file existence ≠ correct imports).
```

**Denominator rule:** `M` is the count of tasks where BOTH the calibration anchor AND the semantic verifier produced a verdict. Runs where exit-code `testCommands` failed (semantic skipped per existing fail-closed) are excluded from `M`. Otherwise structural disagreements (one side ran, the other didn't) pollute the calibration rate and we can't tell whether the verifier is well-calibrated. The report's "Calibration disagreements: N/M" line is the input to the removal gate; `M` not being all 8 is itself worth noting (logged separately as "Calibration coverage: M/8 tasks").

**The "Investigate:" line is required, not optional.** A disagreement report without an action prompt tells the user there's a problem but not where to look first. Each disagreement entry must include: anchor command(s) + exit code(s), the specific semantic criterion at issue, and a templated "Investigate:" sentence pointing at `verdict-NNN.json` and `executor.log` for the relevant run id. The format is baked into `cli/src/eval/report.ts`; covered by `cli/test/eval/report.test.ts`.

Zero disagreements = clean run. Non-zero = the items to investigate this cycle. Either the anchor is wrong (false fail), the semantic verifier is wrong (rubber-stamp or over-strict), or the criterion's wording is ambiguous. Investigate per-case; don't generalize.

### Calibration-anchor removal gate

The anchor does NOT get removed on a schedule. It gets removed when the eval suite produces **zero disagreements across one full run** (all `M` tasks where both modes produced a verdict — see denominator rule above). If disagreements remain — even one — the calibration period continues; investigate, iterate, re-run, gate again.

A separate BACKLOG entry (`gap-calibration-anchor-removal`) tracks the removal. The entry's trigger explicitly states: **"close when one full eval suite run shows 0/M disagreements between calibration anchor and semantic verifier; not before, not on a timer."** This locks the gate against the same discipline failure pattern we just exited — "we said one cycle, it's been one cycle, ship the removal" is the same shape as "we said three patches, the third hasn't strictly happened yet, ship the patch." We escape only by writing the gate as a measurable condition, not a window.

**Halt condition (also in the BACKLOG entry).** If 3 successive eval suite runs all produce non-zero disagreements AND the disagreement set partially overlaps across runs — i.e., we are chasing the same disagreement across iterations — STOP iterating. Pause, re-evaluate the semantic verifier prompt or the architectural approach itself. The calibration period has its OWN trigger now, structurally identical to `gap-triage-testcommand-pattern-debt`'s trigger: don't iterate indefinitely on a shape-of-failure we have already declined to whack-a-mole. When the halt fires, the appropriate response is to surface for human decision and consider a different approach, NOT to ship a 4th iteration of the same prompt patch.

## Tests

### Unit tests in `packages/runtime/test/verifier/`

**`semanticPrompt.test.ts`** (~7 tests):
- system prompt mentions "bias toward strictness" / "when in doubt, mark `met: false`"
- system prompt contains both worked examples (regex match on signature lines from each)
- example 1 includes a borderline judgment in `reasoning` (regex match on the "returns null" / "does not throw" framing)
- system prompt contains the deletion-hunk clarification ("deletion hunks count as 'touching' a path")
- user prompt template wraps the diff in `# Diff` fenced block
- user prompt template numbers criteria in `# Acceptance criteria` and instructs verbatim echo
- retry prompt inlines `validator errors` block when called via `buildSemanticRetryUserPrompt`

**`semanticSchema.test.ts`** (~12 tests):
- validator accepts a valid per-criterion array (3 entries, all fields present)
- rejects missing `perCriterion`
- rejects empty `perCriterion` array
- rejects entry missing `criterion`
- rejects entry missing `met`
- rejects entry missing `reasoning`
- rejects entry with empty `reasoning`
- rejects entry with `reasoning` over 500 chars
- rejects when output criteria don't cover ALL input criteria
- accepts when output reorders criteria from input (judgment is unordered)
- **rejects when model paraphrases a criterion** (input: `"foo is bar (with detail)"`; output: `"foo is bar"` → validator error). Enforces strict-match policy. (refinement H)
- accepts whitespace-only differences (input: `"foo  is bar"`; output: `"foo is bar"`) and trailing-period stripping

**`semantic.test.ts`** (~10 tests):
- `runSemanticVerifier` happy path: all `met: true` → returns `{ matches: true, perCriterion: [...] }` + emits token usage
- mixed pass/fail → `matches: false`, individual judgments preserved
- one `met: false` → `matches: false`
- SDK throws → fail-closed default → returns `{ matches: false, perCriterion: [], reasoning: '...SDK error...' }`
- SDK throws + `semanticOnSdkError: 'skip'` → returns sentinel "skipped" verdict; warn logged
- invalid output → 1 retry with validator errors inlined
- two consecutive invalid → synthesized `{ matches: false, reasoning: 'invalid output twice' }`
- diff over 30 KB → truncated, marker appended, included file list
- diff exactly at 30 KB → not truncated
- empty diff (no changes) → semantic verifier called with empty diff block; model can judge "no hunks" criteria

**`runVerifier.test.ts`** (~7 tests, replaces parts of existing exitCode tests where composition matters):
- exit-code passes + semantic passes → `pass: true`
- exit-code fails → semantic NOT called → `pass: false`
- exit-code passes + semantic `matches: false` → `pass: false`
- calibration anchor enabled + agreement → no warn log
- calibration anchor enabled + disagreement (anchor pass, semantic fail) → warn log emitted, run outcome = fail per semantic
- calibration anchor enabled + disagreement (anchor fail, semantic pass) → warn log emitted with "POTENTIAL FALSE POSITIVE" tag, run outcome = pass per semantic
- **calibration mode OFF**: `verdict.calibrationAnchor` is `undefined`; no anchor commands spawned (assert via `runCommand` spy); no anchor-related warn logs; verdict serializes to JSON cleanly. Protects against "calibration mode bled into production" regression. (refinement I)

**`calibrationAnchor.test.ts`** (~4 tests):
- runs anchor commands sequentially via `runCommand`
- aggregates exit codes; `anchorPass` = all-zero
- `agreement` field correctly computed against a passed-in verdict pass/fail
- anchor disabled (`calibrationTestCommands` empty or `calibrationMode: false`) → returns `undefined`, no commands run

### Integration test

**`verifier/integration.test.ts`** (1 test, mocked SDK + real fs):
- Fixture: tiny repo with one src file, one test file, an applied "diff" (manually staged).
- Criteria: 3 items covering one met, one met:false, one path-untouched.
- Mocked SDK returns canned per-criterion judgments.
- Asserts: verdict shape end-to-end, `pass` aggregation rule, `semanticCheck.perCriterion` round-trips through `Verdict` type, calibration anchor block populated when enabled.

### Eval-layer tests

No new unit tests for the eval runner itself — the eval suite IS the integration test for the calibration mechanism. But:
- `cli/test/eval/runner.test.ts` gains coverage that `calibrationTestCommands` from `expected.json` are passed through to `VerifyOptions` when `--calibration-mode` is set, AND ignored without the flag.
- `cli/test/eval/report.test.ts` (new, ~5 tests): summary contains "Calibration disagreements: N/M" line; summary contains "Calibration coverage: M/8 tasks" line; details bullets per disagreement include anchor commands + exit codes + the "Investigate:" line; "0/M tasks disagreed" wording for clean run; section omitted entirely when calibration mode was off.

### Live calibration (the real test)

After all unit tests + integration tests are green: full eval-suite run with `--with-triage --calibration-mode`. Two assertions, made by reading the report:
1. **CHECKPOINT 3 gate**: ≥7/8 tasks PASS (existing gate, unchanged by this refactor).
2. **Anchor removal gate**: `Calibration disagreements: 0/M`. If not zero, investigate every disagreement, iterate, re-run. Anchor removal commit waits until this gate fires (see `gap-calibration-anchor-removal`).

The unit tests prove the mechanism works; the live calibration proves the verifier's judgment is well-calibrated. Distinct concerns. Tests stay mocked-SDK; no live LLM in CI.

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
9. **Calibration anchor** — temporary side-channel comparison: keep the OLD testCommands in a `expected.json.calibrationTestCommands` field, run them alongside the new flow during eval runs, log warn-level on disagreement, surface disagreements in eval report summary. Anchor is signal-only — semantic verdict is authoritative for run outcome. Single commit.
10. **Re-run CHECKPOINT 3** — must hit ≥7/8 to proceed to Phase F (per your stated gate). Calibration disagreement count is logged but does NOT block CHECKPOINT 3's ≥7/8 gate (a disagreement is a signal to investigate, not a gate). However, the anchor removal step (11) is separately gated on zero disagreements.
11. **Remove the calibration anchor** — separate later commit, **gated on one full eval suite run with 0/8 disagreements**. Tracked as a new BACKLOG entry (`gap-calibration-anchor-removal`). Not on a timer, not "after a cycle" — only on measurable agreement. If the first re-run shows N>0 disagreements, investigate each (anchor-wrong / verifier-wrong / criterion-ambiguous), fix, re-run; anchor stays until the gate fires.

Estimated work: 2–3 sessions for steps 2–9; one CHECKPOINT 3 re-run; removal of anchor is a separate later commit. Multi-commit; conventional commit format throughout; each step tests + typechecks before commit.

## Signoff status (2026-05-24)

All seven open questions signed off by user, with the refinements below incorporated above:

1. **Restricted testCommand vocabulary** — SIGNED. Ship minimal starting set. Expand on concrete signal.
2. **Calibration anchor** — SIGNED, with two refinements: (a) disagreement-logging policy explicit in §"Calibration-anchor disagreement policy"; (b) removal gated on **zero disagreements**, not on a cycle count. New BACKLOG entry `gap-calibration-anchor-removal` carries the gate.
3. **SDK-error default** — SIGNED, with refinement: **production also defaults to fail-closed.** Opt-in only via explicit CLI flag `--semantic-verification-on-error <strict|skip>`, default `strict`. No env-var / config-file path. Eval suite hard-coded to `strict`.
4. **Verdict.semanticCheck.perCriterion field** — SIGNED.
5. **Pricing constants hoisting** — SIGNED.
6. **Examples in the semantic verifier prompt** — SIGNED, with refinement: **at least one example must include a borderline-case judgment** in the `reasoning` field (not "function X exists in diff → met: true"). Trivial pairs teach rubber-stamping; the reasoning depth in the examples is what we're calibrating the model toward.
7. **Vocabulary in triage prompt + schema** — SIGNED (both).

## Review gate before code starts

Before I begin step 2 (pricing hoisting), four sections of this document are sent back inline for review:
- The semantic verifier's prompt structure (system prompt, user prompt template, output schema)
- The exact migration of the 5 `expected.json` files (each file's old → new content)
- The disagreement-logging mechanic for the calibration anchor (per refinement A)
- The new verifier's test plan (unit, integration, eval)

After signoff on those four sections, proceed to code. Same execution rules: reversible decisions called inline, irreversible/scope-changing ones surfaced for approval.

Phase F starts after the refactor lands AND CHECKPOINT 3 re-run hits ≥7/8 AND the calibration anchor produces zero disagreements on that re-run.
