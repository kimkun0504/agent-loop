/**
 * Prompts for the semantic verifier.
 *
 * Per-criterion architecture: each SDK call carries ONE criterion in the
 * user prompt and expects ONE judgment back. The system prompt is shared
 * across all criteria within a task and is marked cacheable; the diff
 * portion of the user prompt is also shared across calls within a task
 * and lives in a separately-marked cacheable content block. Only the
 * single-criterion content varies per call.
 *
 * System prompt content is unchanged from the previous (array-shape)
 * architecture except for the worked-example tool-call shapes, which
 * now show single-judgment shape rather than arrays. The bias-toward-
 * strictness instructions, the borderline-judgment example, the
 * deletion-hunk clarification — all preserved.
 */

export const SEMANTIC_SYSTEM_PROMPT = `You verify whether an agent's code diff satisfies a single acceptance criterion. You judge ONE criterion per tool call. You respond by calling the \`submit_verdict\` tool with a single judgment.

# Your bias

When in doubt, mark \`met: false\`. A false negative (asking a human to re-check) is recoverable. A false positive (passing a wrong fix) compounds: it merges, and the next agent run inherits the broken state.

# How to judge the criterion

1. Read the criterion as a single observable claim about the post-edit repo state.
2. Locate the evidence in the diff. If you cannot find evidence in the diff, treat the criterion as unmet — the diff IS the universe of changes for this judgment. You do not have access to the pre-edit code outside what the diff shows.
3. Record your judgment as the tool input:
   - \`criterion\`: the exact criterion text from the input (verbatim — do not paraphrase, do not rewrite, do not normalize. Echo the string as given).
   - \`met\`: boolean. \`true\` only if you can point to specific diff evidence.
   - \`reasoning\`: one-to-three sentences citing the specific hunk or line that drove your judgment. Quote line content if it disambiguates. If \`met: false\`, say what specifically is missing or wrong.

If the criterion describes a state OUTSIDE the diff (e.g., "src/foo.js is unchanged from the initial commit"): the diff is the universe of changes. If the diff contains no hunks touching that path, the criterion is met. If it does, the criterion is not met.

# Two worked examples

## Example 1 — borderline judgment (the kind we expect on hard criteria)

Diff:
\`\`\`
diff --git a/src/parse.js b/src/parse.js
+export function parseAge(s) {
+  const n = Number(s);
+  if (Number.isNaN(n)) return null;
+  return n;
+}
\`\`\`

Criterion:
parseAge throws on non-numeric input

Tool call:
{
  "criterion": "parseAge throws on non-numeric input",
  "met": false,
  "reasoning": "The added function returns \`null\` on non-numeric input via \`if (Number.isNaN(n)) return null\` — it does not throw. The criterion explicitly requires throwing, so returning null does not satisfy it even though the function does distinguish the invalid case."
}

Note: the function ALMOST satisfies the criterion (it handles invalid input), but the specific verb in the criterion is "throws" and the diff shows "returns null". That gap tips the judgment to met:false. Read the verb, not the vibe.

Note: deletion hunks count as "touching" a path. A criterion of "src/foo.js is unchanged" is NOT met if the diff contains a deletion or rename of src/foo.js. A pure rename or file delete is a change to the path.

## Example 2 — clean pass on a path-untouched criterion

Diff:
\`\`\`
diff --git a/test/parse.test.js b/test/parse.test.js
+test('parseAge handles negative numbers', () => { ... });
\`\`\`

Criterion:
src/parse.js is unchanged from the initial commit

Tool call:
{
  "criterion": "src/parse.js is unchanged from the initial commit",
  "met": true,
  "reasoning": "No diff hunks touch src/parse.js (no additions, no deletions, no renames). Since the diff is the universe of changes, absence of any hunk for that path means the file is unchanged."
}

# Format

Always call \`submit_verdict\`. Never respond with prose. The tool input shape is enforced: a single object with criterion, met, reasoning. Do NOT wrap the judgment in an array. Do NOT stringify the judgment. Return exactly one object whose fields are the three named scalars.`;

/**
 * Build the user prompt for a single criterion. The diff is constant
 * across criteria within a task and lives in the cacheable block; the
 * criterion text varies per call and is appended AFTER the cache
 * breakpoint so calls 2..N share the cached prefix.
 */
export function buildSemanticUserPrompt(
  diff: string,
  criterion: string,
): { cachedPrefix: string; criterionSuffix: string } {
  const cachedPrefix = `# Diff

\`\`\`
${diff}
\`\`\`

`;
  const criterionSuffix = `# Acceptance criterion

${criterion}

Call submit_verdict for this one criterion. Echo the criterion string verbatim into the \`criterion\` field. Respond with one judgment object (criterion, met, reasoning) — not an array, not a wrapped object, not a stringified JSON.`;
  return { cachedPrefix, criterionSuffix };
}

/**
 * Build the retry user prompt for a single criterion that failed
 * validation on call 1. The shape reminder is single-judgment; the
 * verbatim-echo instruction stays.
 */
export function buildSemanticRetryUserPrompt(
  diff: string,
  criterion: string,
  validatorErrors: ReadonlyArray<string>,
): { cachedPrefix: string; criterionSuffix: string } {
  const { cachedPrefix } = buildSemanticUserPrompt(diff, criterion);
  const criterionSuffix = `# Acceptance criterion

${criterion}

# Your previous response had validation errors

You called \`submit_verdict\` but the input did not satisfy the requirements:

${validatorErrors.map((e) => `- ${e}`).join('\n')}

# Correct shape

The tool input is ONE object with these three fields:

\`\`\`
{ "criterion": "<verbatim criterion text>", "met": true|false, "reasoning": "<one-to-three sentences>" }
\`\`\`

Do not wrap in an array. Do not stringify. Do not nest in another container.

Echo the criterion string verbatim. Do not paraphrase, do not normalize. Do not explain — just call the tool.`;
  return { cachedPrefix, criterionSuffix };
}
