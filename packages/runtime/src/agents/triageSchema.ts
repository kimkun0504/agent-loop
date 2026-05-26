/**
 * JSON schema for the triage tool's input + TS types that mirror it.
 *
 * The model is forced to call a single tool, `submit_triage_result`,
 * whose input is the shape below. We get a guaranteed JSON object back;
 * structural validity is the SDK's job, semantic validity is
 * triageValidate's job.
 *
 * Discriminator: `kind` is `"spec"` or `"rejection"`. The schema lists
 * `spec` and `rejection` as separate optional object properties; the
 * validator enforces "populate the right one for the discriminator".
 * Standard JSON Schema discriminated unions via `anyOf` work in
 * principle but Anthropic's input_schema validator is conservative —
 * we'd rather enforce the invariant in our own validator than wedge
 * the SDK's parser into a corner.
 */

import type { TokenUsage, FileStateCheck } from '@agent-loop/core';

export const TRIAGE_TOOL_NAME = 'submit_triage_result';

/**
 * Vocabulary of testCommands the verifier knows how to run. Triage picks
 * from this enum; novel shell commands are schema-rejected.
 *
 * Scope: JS/TS only for Week 3. Adding language support (`cargo test`,
 * `go test`, `pytest`, etc.) means adding entries here — deliberate,
 * reviewable, schema-enforced. The triage system prompt also lists this
 * vocabulary explicitly with rationale.
 *
 * Anything outside this set (file-state assertions, absence checks,
 * "don't touch X" guards) goes in acceptanceCriteria as natural
 * language; the semantic verifier judges those against the diff.
 */
export const VALID_TEST_COMMANDS = [
  'npm test',
  'npm run typecheck',
  'npm run lint',
  'npm run build',
  'pnpm test',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm build',
] as const;

export type ValidTestCommand = typeof VALID_TEST_COMMANDS[number];

export const TRIAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['spec', 'rejection'],
      description:
        'Pick "spec" when the task is actionable and you can infer testable acceptance criteria. Pick "rejection" when it is not, too vague, or too broad.',
    },
    spec: {
      type: 'object',
      description: 'Required when kind === "spec".',
      properties: {
        title: {
          type: 'string',
          maxLength: 200,
          description: 'One-line PR title.',
        },
        description: {
          type: 'string',
          maxLength: 5_000,
          description:
            '2–5 paragraphs explaining what to do and why. Will appear in the PR body.',
        },
        fileScope: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description:
            'Glob patterns the agent may edit. Name specific files when the task mentions them; use broader globs like "src/**/*.js" only when the task is general. Never use ["**/*"].',
        },
        acceptanceCriteria: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description:
            '3–8 concrete, testable bullet points. Each one should be verifiable by an exit-code check or by reading the diff.',
        },
        testCommands: {
          type: 'array',
          minItems: 0,
          maxItems: 5,
          items: {
            type: 'string',
            enum: [
              'npm test',
              'npm run typecheck',
              'npm run lint',
              'npm run build',
              'pnpm test',
              'pnpm typecheck',
              'pnpm lint',
              'pnpm build',
            ],
          },
          description:
            'Test commands the verifier will run. PICK FROM THE ENUM ONLY — novel shell commands are schema-invalid. File-state assertions ("file X is unchanged", "file Y is deleted") go in fileStateChecks; behavior claims go in acceptanceCriteria. Empty array is acceptable if the task is verifiable entirely by acceptanceCriteria + fileStateChecks (e.g., a docs-only change).',
        },
        fileStateChecks: {
          type: 'array',
          minItems: 0,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['unchanged', 'deleted', 'exists', 'absent'],
              },
              path: { type: 'string', minLength: 1 },
            },
            required: ['type', 'path'],
            additionalProperties: false,
          },
          description:
            'Structured file-state assertions, mechanically verified by the verifier. Use this for ANY claim about a file\'s existence or non-modification. Types: "unchanged" (file is unchanged from initial commit), "deleted" (file no longer exists), "exists" (file is present), "absent" (file is not present). Path is relative to the repo root. PREFER fileStateChecks over acceptanceCriteria for file-state claims — these are deterministic, the semantic verifier cannot judge unchanged-file content from a diff. Content-preservation claims ("test for X is preserved") belong in acceptanceCriteria as diff-observable negative claims ("no hunk deletes the assertion ...").',
        },
      },
      required: ['title', 'description', 'fileScope', 'acceptanceCriteria', 'testCommands'],
    },
    rejection: {
      type: 'object',
      description: 'Required when kind === "rejection".',
      properties: {
        reason: {
          type: 'string',
          enum: ['not_actionable', 'too_vague', 'out_of_scope'],
          description:
            'not_actionable: task asks for design opinion, not code. too_vague: no testable criteria can be inferred. out_of_scope: spans many files / suggests a multi-PR initiative.',
        },
        message: {
          type: 'string',
          maxLength: 1_000,
          description:
            'Short human-readable explanation. Will appear in the failure log.',
        },
        clarifyingQuestions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For reason="too_vague": 2–4 questions a human reviewer could answer to make the task actionable.',
        },
      },
      required: ['reason', 'message'],
    },
  },
  required: ['kind'],
} as const;

// --- Domain types -------------------------------------------------------

export interface TriageProducedSpec {
  title: string;
  description: string;
  fileScope: string[];
  acceptanceCriteria: string[];
  testCommands: string[];
  /**
   * Structured file-state assertions (Option E). Optional; absence
   * means triage didn't author any file-state claims for this task,
   * not that the task has no file-state requirements. See
   * docs/triage-file-reference-rethink.md.
   */
  fileStateChecks?: FileStateCheck[];
}

export type TriageRejectionReason =
  | 'not_actionable'
  | 'too_vague'
  | 'out_of_scope'
  | 'invalid_output'   // synthesized by us when the model output won't validate
  | 'sdk_error';        // synthesized on network/auth/rate-limit errors

export type TriageResult =
  | {
      ok: true;
      spec: TriageProducedSpec;
      /** Per-call usage in order — the agent applies record_token_usage for
       *  each entry, but exposes them too so callers can log totals. */
      usages: TokenUsage[];
    }
  | {
      ok: false;
      reason: TriageRejectionReason;
      message: string;
      clarifyingQuestions?: string[];
      usages: TokenUsage[];
    };
