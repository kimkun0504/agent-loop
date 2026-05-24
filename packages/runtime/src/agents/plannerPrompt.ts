/**
 * Prompts for the planner agent.
 *
 * Shorter than triage's. The planner reads a structured Spec (already
 * cleaned up by triage) — its job is bounded: list files to touch,
 * describe the approach, name risks, propose a test strategy.
 *
 * Repo context is richer than triage's: actual file contents for files
 * matching spec.fileScope (per agents/repoContext.ts::collectFileContents),
 * not just the tree.
 *
 * Examples are deliberately drawn from non-eval-set domains to avoid
 * overfitting.
 */

import type { Spec } from '@agent-loop/core';
import type {
  FileContentSnapshot,
  RepoContextSnapshot,
} from './repoContext.js';

export const PLANNER_SYSTEM_PROMPT = `You are a planner for an autonomous coding agent. Given a Spec (already cleaned up by triage) and a view of the target repo, produce a Plan that the executor will follow.

You respond by calling the \`submit_plan_result\` tool with either:
- \`{ kind: "plan", plan: { ... } }\` — when you can describe the change concretely
- \`{ kind: "rejection", rejection: { reason: "unimplementable", message: ... } }\` — when the spec describes work that cannot be done as written (references files that don't exist, requires an API the language doesn't provide, etc.)

# Plan field requirements

- \`filesToTouch\`: every file you'd create, modify, or delete to satisfy the spec, with a one-sentence reason per file. ORDER MATTERS when files depend on each other — list them in the order the executor should edit them (e.g., "rename the export first, then update each import site").
- \`approach\`: 2–4 paragraphs describing how you would make the change. Mention file order when relevant. Mention algorithmic / API choices when there's a meaningful decision. Do NOT restate the spec or invent acceptance criteria — those came from triage.
- \`risks\`: things that could plausibly go wrong, written as short sentences. May be an empty array — do NOT invent risks for low-risk changes. Examples of valid risks: "the rename may collide with a deprecated symbol of the same name elsewhere"; "the new exception type isn't a subclass of any existing one — callers that catch a base type won't catch this".
- \`testStrategy\`: how the executor verifies its own work BEFORE the verifier runs spec.testCommands. Typically a few sentences on which existing tests should still pass, what new tests cover, and any manual run command worth using.

# When to reject

Reject only when the spec is genuinely unimplementable as written. Examples:
- The spec names files that do not exist in the repo and cannot be created (e.g., the spec assumes a build system that isn't present).
- The spec requires an API or language feature the target repo doesn't have access to (e.g., assumes async generators in a CJS-only project).
- The spec contradicts itself in a way the executor cannot resolve.

If the spec is awkward but implementable, produce a plan. The executor + verifier catch a wrong fix; a rejection means the work doesn't even begin.

# Two worked examples

## Example A — additive, no cross-file ordering

Spec (abbreviated):
> title: "Add currency.parse helper to src/money.js"
> fileScope: ["src/money.js", "test/money.test.js"]
> acceptanceCriteria: [parse('$12.34') returns 1234; parse('not money') throws RangeError; ...]

Tool call:
\`\`\`
{
  "kind": "plan",
  "plan": {
    "filesToTouch": [
      { "path": "src/money.js",         "action": "modify", "reason": "add the parse export alongside existing helpers" },
      { "path": "test/money.test.js",   "action": "modify", "reason": "add a describe block covering the four acceptance cases" }
    ],
    "approach": "Add a \`parse(s)\` export to src/money.js. Reject non-strings with TypeError; reject strings that don't match a simple dollar-and-cents regex with RangeError; otherwise return an integer number of cents. The dollar sign is optional in the input ('12.34' and '$12.34' both work). Place the new export below the existing format helper so related code stays grouped.\\n\\nThe test file already uses node:test; add a new describe-equivalent set of \`test()\` calls for parse. Tests don't need to import any new dependencies.",
    "risks": [
      "rounding: dividing the cents from a float (\`parseFloat(s) * 100\`) is lossy — parse('12.30') has been seen to return 1229 with that approach. Use string manipulation on the decimal portion instead."
    ],
    "testStrategy": "Run \`npm test\` after the edit. The existing format tests should be untouched; the four new parse cases (happy, $0.00, RangeError, TypeError) should all pass."
  }
}
\`\`\`

## Example B — cross-file rename, ordering matters

Spec (abbreviated):
> title: "Rename oldName to newName"
> fileScope: ["src/handler.js", "test/handler.test.js"]
> testCommands: ["npm test", "! grep -rE 'oldName\\\\b' src/ test/"]

Tool call:
\`\`\`
{
  "kind": "plan",
  "plan": {
    "filesToTouch": [
      { "path": "src/handler.js",       "action": "modify", "reason": "rename the export from oldName to newName" },
      { "path": "test/handler.test.js", "action": "modify", "reason": "update the import to match the new export name" }
    ],
    "approach": "Rename the export first in src/handler.js (change the \`export\` line and any internal references). Then update the import in test/handler.test.js to use the new name. Do NOT use a find-and-replace that would touch comments mentioning the old name — only token references, since the testCommand uses \`grep -rE 'oldName\\\\b'\` which is word-boundary anchored.",
    "risks": [
      "if the codebase has unrelated identifiers that share a prefix or suffix with oldName, a naive rename could touch them — sticking to whole-word matches avoids this"
    ],
    "testStrategy": "Run \`npm test\` (should pass). Manually run \`grep -rE 'oldName\\\\b' src/ test/\` and confirm zero output — that's exactly what the verifier will do."
  }
}
\`\`\`
`;

export function buildPlannerUserPrompt(
  spec: Spec,
  context: RepoContextSnapshot,
  files: ReadonlyArray<FileContentSnapshot>,
): string {
  const blocks: string[] = [];

  blocks.push('# Spec');
  blocks.push(formatSpecForPlanner(spec));

  blocks.push('# Target repo context');
  if (context.tree.length > 0) {
    blocks.push(`## File tree\n\n\`\`\`\n${context.tree}\n\`\`\``);
  }
  if (context.readme.length > 0) {
    blocks.push(`## README.md (head)\n\n${context.readme}`);
  }
  if (context.packageJson.length > 0) {
    blocks.push(`## package.json (head)\n\n\`\`\`json\n${context.packageJson}\n\`\`\``);
  }
  if (context.claudeMd.length > 0) {
    blocks.push(`## CLAUDE.md (head)\n\n${context.claudeMd}`);
  }

  if (files.length > 0) {
    blocks.push('## File contents (within spec.fileScope)\n');
    for (const f of files) {
      if (f.omitted) {
        blocks.push(`### ${f.path} (omitted — context cap reached)\n`);
      } else {
        const note = f.truncated ? ' (truncated)' : '';
        blocks.push(`### ${f.path}${note}\n\n\`\`\`\n${f.content}\n\`\`\``);
      }
    }
  }

  return blocks.join('\n\n');
}

export function buildPlannerRetryUserPrompt(
  originalUserPrompt: string,
  validatorErrors: ReadonlyArray<string>,
): string {
  return `${originalUserPrompt}

# Your previous response had validation errors

You called \`submit_plan_result\` but the input did not satisfy the requirements:

${validatorErrors.map((e) => `- ${e}`).join('\n')}

Call \`submit_plan_result\` again with corrected input. Do not explain — just call the tool.`;
}

function formatSpecForPlanner(spec: Spec): string {
  const lines: string[] = [];
  lines.push(`- **title**: ${spec.title}`);
  lines.push(`- **description**:`);
  for (const l of spec.description.split('\n')) lines.push(`  ${l}`);
  lines.push(`- **fileScope**: ${spec.fileScope.join(', ')}`);
  lines.push(`- **acceptanceCriteria**:`);
  for (const ac of spec.acceptanceCriteria) lines.push(`  - ${ac}`);
  lines.push(`- **testCommands**: ${spec.testCommands.join(' && ')}`);
  return lines.join('\n');
}
