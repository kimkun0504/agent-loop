# Triage file-reference rethink

Status: rethink doc (not yet decided). Triggered by the iteration cap on `gap-triage-testcommand-pattern-debt`: three failures across three rounds in the same underlying family (criteria reference file state the verifier can't observe from the diff), so we pause and reconsider rather than write patch #3.

## The pattern, across rounds

The runtime-claim wording in rounds 1 and 2 was decoration. The cause is older and more general: **triage occasionally produces acceptance criteria that make assertions about files the agent's diff doesn't touch.** The semantic verifier, by design, judges only what the diff shows ("the diff is the universe of changes"). A criterion that references a file with no hunks is unjudgeable from the verifier's input.

Instances:
- **CP3 re-run #2, add-clamp #10**: "npm test passes" — wholesale runtime claim. Patched at commit `831dfe6`.
- **CP3 re-run #1, add-clamp**: "the existing multiply test in test/math.test.js still passes" — runtime claim about an unchanged file. Same root.
- **Round 2 (round-2 gate), runtime-claim compound**: "test/math.test.js contains a test for the multiply function and it still passes" — compound observable + runtime. Patched at commit `ac4361c` + meta-test at `4652df9` + regex tightening at `c739131`.
- **Round 3 (refined-gate), add-clamp**: "test/math.test.js still contains and exercises the existing multiply test" — no runtime keyword; the failure mechanism is identical. The meta-test correctly didn't flag it (no runtime claim); the verifier correctly judged met:false (file not in diff).

Common task shape: `add-clamp` lets the agent CHOOSE between editing test/math.test.js OR creating test/clamp.test.js. Triage assumes one; the agent picks the other; criteria about triage's assumed file become unverifiable. Same failure across 3 of 5 valid eval runs in the refined-gate validation, scattered across rounds.

Single-task data, but the mechanism generalizes to any task with "either modify X or create Y" semantics — and that pattern will be common in real GitHub Issues.

## Options

**Option A — Another anti-pattern entry in the triage prompt.**
Forbid "criteria about files the agent isn't required to touch." Patch #3 in the same trajectory.
*Pros*: cheap; consistent with prior patches; doesn't change architecture.
*Cons*: this is exactly the trajectory the iteration cap was written to halt. Each patch is more specific and brittle than the last; "criteria about files not modified" is a structural property, not a wording quirk.

**Option B — Structural file-referencing guidance in the triage prompt.**
Tell triage: "criteria reference only files with evidence-based connection to the change you're proposing." Less enumerative than A; more like a principle.
*Pros*: more principled than enumerating shapes; trains the model on the deeper rule.
*Cons*: still a prompt change; same iteration-cap concern; "evidence-based connection" is hard to specify precisely; legitimate criteria sometimes need to reference adjacent files.

**Option C — Verifier tolerance for unchanged-file claims.**
Soften the verifier: if a criterion claims content about a file with no hunks, judge based on filesystem inspection instead of the diff.
*Pros*: catches the actual ground truth.
*Cons*: **rubber-stamping risk** — the whole strictness premise was "diff is universe of changes" precisely to prevent the verifier from being lenient. Filesystem access means two verifier modes (diff-only and full-fs) — state machine complexity. The Verdict's confidence drops because we're trusting a non-diff source.

**Option D — Move file-state claims back into testCommands.**
File-state assertions ("unchanged", "deleted", "exists at path X") move out of `acceptanceCriteria` and into `testCommands` as shell commands. Unwinds part of commit `884acad` (vocabulary restriction).
*Pros*: file-state is inherently exit-code-shaped; mechanical verification beats LLM judgment for "does this file exist."
*Cons*: re-opens the testCommand-rewriting failure family (CP2/CP3 patch trajectory) which we deliberately exited. testCommands becomes free-form again for these cases; we'd need to constrain it to safe patterns, which is just the original problem in smaller form.

**Option E — Structured file-state checks as a separate Spec field.**
New `Spec.fileStateChecks?: FileStateCheck[]` where `FileStateCheck = { type: 'unchanged' | 'deleted' | 'exists' | 'absent', path: string }`. Verifier translates each check to deterministic shell mechanically (`git diff --quiet main -- <path>` for `unchanged`, `test -f <path>` for `exists`, etc.). Triage prompt teaches: file-state claims go in fileStateChecks; behavior claims go in acceptanceCriteria.
*Pros*: mechanical verification on file-state (no rubber-stamping); semantic verifier stays strict on behavior; triage prompt becomes simpler (clear separation); the 4-type enum is small enough to keep stable.
*Cons*: new schema field on Spec; triage prompt expansion (instructions for two lists); requires migration of existing eval task fixtures' `expected.json`.

**Option F — Triage gets "you don't know which files the agent will touch" rule.**
Tell triage explicitly: NEVER make claims about files outside its declared `fileScope`. If the task says "may modify X or create Y," fileScope includes both AND criteria are conditional.
*Pros*: principled; targets the failure mechanism directly.
*Cons*: still a prompt change; conditional criteria ("X is unchanged OR Y is created with ...") are themselves complex; the model has to reason about logical disjunctions, which is harder than declarative claims.

## Recommendation: Option E

**Mechanical verification of file-state is the right primitive here.** Three observations support this:

1. **The failure mode has a real impedance mismatch.** The semantic verifier judges from the diff; file-state claims about unchanged files are inherently outside its input. The verifier isn't wrong; the criterion is asking it to do something it can't. A structural fix removes the question.

2. **The fix doesn't depend on the model getting it right.** Options A, B, F all rely on the triage model following a new rule. The previous two rounds showed that rules in the prompt are followed mostly-but-not-always, and the cases where they break are exactly the borderline cases we care about. Mechanical verification is deterministic.

3. **It honors the iteration cap.** The cap was written to prevent the patch trajectory. Option E is not a patch — it's a schema + verifier change. It puts the work in a layer the model doesn't get to author.

Option E vs. Option D: both move file-state to mechanical verification. The difference is that D re-opens the testCommand-rewriting family by allowing free-form shell; E avoids that by making fileStateChecks a STRUCTURED 4-type enum. Triage doesn't author shell; it picks a type and a path.

## BACKLOG update text per option

- **Option A**: "Runtime-claim family iteration count: 3 — added file-reference anti-pattern subsection. Iteration cap was 2; this is the explicit override." (Not recommended; recorded for completeness.)
- **Option B**: same as A but worded as "structural guidance rather than enumeration." Same iteration concern.
- **Option C**: "Verifier rule changed to allow filesystem inspection on unchanged-file claims. Rubber-stamping risk tracked separately as new BACKLOG entry."
- **Option D**: "testCommand vocabulary expanded to include `git diff --quiet main -- <path>` and `test -f <path>` shell patterns for file-state. Original CP2/CP3 testCommand-rewriting family re-opened in scoped form."
- **Option E (recommended)**: "The runtime-claim family is closed by Option E (structured fileStateChecks). Iteration cap honored at 2 — we paused at the third instance and chose a structural fix rather than producing patch #3. The new failure surface is whether triage picks the right enum value and path; if that becomes a problem, it's a new family with its own cap. Tracked as gap-spec-file-state-checks (resolved by this work) and as new BACKLOG entry."

## Implementation sketch (Option E)

Files that change:

1. **`packages/core/src/types/index.ts`**: add `FileStateCheck` type and `Spec.fileStateChecks?: FileStateCheck[]` field.
2. **`packages/runtime/src/agents/triageSchema.ts`**: add `fileStateChecks` to `TRIAGE_INPUT_SCHEMA` as a JSON-schema enum-typed array; add `TriageProducedSpec.fileStateChecks?`.
3. **`packages/runtime/src/agents/triageValidate.ts`**: validate the new field (type one of 4 values, path non-empty).
4. **`packages/runtime/src/agents/triagePrompt.ts`**: new field-guidance section "fileStateChecks: structured file-state assertions". Examples for each of the 4 types. Move the "file is unchanged" pattern from acceptanceCriteria guidance into fileStateChecks. Update the worked examples C and D to emit fileStateChecks instead of acceptanceCriteria for file-state claims.
5. **`packages/runtime/src/verifier/fileState.ts`** (new): translates `FileStateCheck[]` to shell commands and runs them via `runCommand`. Each type maps deterministically: `unchanged` → `git diff --quiet main -- <path>`, `exists` → `test -f <path>`, etc.
6. **`packages/runtime/src/verifier/index.ts`**: `runVerifier` composes fileState BEFORE semantic. Same fail-closed pattern as exit-code testCommands (fileState fails → semantic skipped).
7. **`packages/core/src/db/schema.ts`**: migration #6 adds `file_state_checks_json` column to `specs` table. (Or store inside an existing JSON blob; pick the simpler path during implementation.)
8. **`evals/tasks/*/expected.json`** (5 files where triage emitted file-state claims): migrate the file-state claims out of `acceptanceCriteria` into `fileStateChecks`. Run the eval set; expect 5/5 architectural-stability runs.

Tests:
- New `fileState.test.ts`: each of 4 types translates correctly; shell-runner stub returns expected exit codes; aggregation matches the existing `runExitCodeVerifier` pattern.
- `triageValidate.test.ts`: new field is validated; type-enum enforced; missing-path rejected.
- `triagePrompt.test.ts`: new field guidance present; worked examples emit fileStateChecks for file-state criteria.
- `runVerifier.test.ts`: composition tests cover fileState pass + fail + skip-semantic-on-fileState-fail.

Re-validation: one more 5-run gate post-implementation. Refined gate properties unchanged. Specifically watch:
- Architectural-stability tasks 5/5 (including add-clamp — expected to pass since its file-state claims are now mechanical).
- Triage emits sensible fileStateChecks (audit the triage.json files).
- No new failure family at the fileStateChecks layer.

Estimated work: 1–2 sessions for implementation, 75 min for re-validation. Phase F starts after the refined gate clears under the new architecture.

## What this does NOT change

- The per-criterion verifier architecture (commit `6e19e87`) stays. fileStateChecks runs alongside, not instead of.
- The semantic verifier's strict-match policy and worked examples stay.
- The vocabulary lock on testCommands (commit `884acad`) stays.
- The two existing anti-pattern entries in the triage prompt (runtime claims, compound runtime claims) stay; they're still correct for what they cover.

The change is additive: a new declarative channel for file-state, leaving the semantic channel scoped to what it judges well.
