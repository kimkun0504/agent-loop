/**
 * Schema definitions for the semantic verifier's forced tool call.
 *
 * The semantic verifier is given a diff + a list of acceptance criteria
 * and must judge each criterion independently. We DO NOT ask the model
 * for an overall verdict — `matches` is derived as `every(c => c.met)`.
 * The discipline is that the model judges each claim in isolation; we
 * aggregate. Less rubber-stamping.
 */

export const SEMANTIC_TOOL_NAME = 'submit_verdict';

export interface PerCriterionJudgment {
  readonly criterion: string;
  readonly met: boolean;
  readonly reasoning: string;
}

export interface SemanticVerdictPayload {
  readonly perCriterion: ReadonlyArray<PerCriterionJudgment>;
}

export const SEMANTIC_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    perCriterion: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string', minLength: 1 },
          met: { type: 'boolean' },
          reasoning: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['criterion', 'met', 'reasoning'],
        additionalProperties: false,
      },
    },
  },
  required: ['perCriterion'],
  additionalProperties: false,
};
