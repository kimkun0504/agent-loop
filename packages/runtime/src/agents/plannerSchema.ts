/**
 * Tool schema + TS types for the planner agent. Same discriminated-union
 * pattern as triage: model is forced to call `submit_plan_result` with
 * either { kind: 'plan', plan: {...} } or { kind: 'rejection', rejection: {...} }.
 */

import type { PlannedFileChange, TokenUsage } from '@agent-loop/core';

export const PLANNER_TOOL_NAME = 'submit_plan_result';

export const PLANNER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['plan', 'rejection'],
      description:
        'Pick "plan" when you can describe the change as a concrete file list + approach. Pick "rejection" when the spec is unimplementable as-given.',
    },
    plan: {
      type: 'object',
      description: 'Required when kind === "plan".',
      properties: {
        filesToTouch: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              action: {
                type: 'string',
                enum: ['create', 'modify', 'delete'],
              },
              reason: {
                type: 'string',
                description:
                  'One sentence on why this file changes. Becomes part of the plan artifact.',
              },
            },
            required: ['path', 'action', 'reason'],
          },
        },
        approach: {
          type: 'string',
          maxLength: 3_000,
          description:
            '2–4 paragraphs describing how you would make the change. Mention file order when it matters (e.g., "rename the export first, then update imports").',
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Things that could go wrong. May be an empty array if the change is genuinely low-risk; do not invent risks.',
        },
        testStrategy: {
          type: 'string',
          maxLength: 1_500,
          description:
            'How the executor should verify its own work BEFORE the verifier runs the spec\'s testCommands. Typically: which existing tests to run, what new assertions to add.',
        },
      },
      required: ['filesToTouch', 'approach', 'risks', 'testStrategy'],
    },
    rejection: {
      type: 'object',
      description: 'Required when kind === "rejection".',
      properties: {
        reason: {
          type: 'string',
          enum: ['unimplementable'],
          description:
            'The only rejection reason that makes sense for a planner. Use it when the spec describes work that cannot be done as described (e.g., references files that do not exist, requires an API the language does not provide).',
        },
        message: {
          type: 'string',
          maxLength: 1_000,
          description: 'Short human-readable explanation. Will appear in the failure log.',
        },
      },
      required: ['reason', 'message'],
    },
  },
  required: ['kind'],
} as const;

// --- Domain types ---------------------------------------------------------

export interface PlannerProducedPlan {
  filesToTouch: PlannedFileChange[];
  approach: string;
  risks: string[];
  testStrategy: string;
}

export type PlannerRejectionReason =
  | 'unimplementable'
  | 'invalid_output'
  | 'sdk_error';

export type PlannerResult =
  | { ok: true; plan: PlannerProducedPlan; usages: TokenUsage[] }
  | {
      ok: false;
      reason: PlannerRejectionReason;
      message: string;
      usages: TokenUsage[];
    };
