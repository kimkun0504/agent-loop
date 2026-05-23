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

import type { TokenUsage } from '@agent-loop/core';

export const TRIAGE_TOOL_NAME = 'submit_triage_result';

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
          minItems: 1,
          items: { type: 'string' },
          description:
            'Shell commands the verifier will run after the agent edits. All must exit 0 for the run to pass.',
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
