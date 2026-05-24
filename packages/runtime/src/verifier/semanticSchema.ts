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

/**
 * Debug artifact written when the semantic verifier hits at least one
 * validation failure (call 1 invalid → retry, regardless of retry outcome).
 *
 * Captures the raw model output before validation so a human reviewing the
 * artifact can see exactly what shape the model produced and why the
 * validator rejected it. Without this, "perCriterion is not an array"
 * is opaque — we'd have to guess between "object keyed by criterion",
 * "wrapped array", "stringified JSON", or "truncated response".
 *
 * Successful runs (call 1 valid, no retry) do NOT produce this artifact;
 * the parsed perCriterion already lives on verdict-NNN.json.
 *
 * SDK errors (no tool_use response at all) do NOT produce this artifact;
 * there's no model output to capture.
 */
export interface SemanticDebugCall {
  /** The user prompt sent on this call. Call 1 is the original; call 2 is the retry with validator-error feedback inlined. */
  readonly userPrompt: string;
  /** The literal `input` from the model's tool_use block. Whatever it produced, before our validator parsed it. */
  readonly rawToolInput: unknown;
  /** Validator complaints. Present iff this call failed validation. Absent for the call that ultimately produced a valid result. */
  readonly validatorErrors?: ReadonlyArray<string>;
}

export interface SemanticDebug {
  readonly systemPrompt: string;
  readonly calls: ReadonlyArray<SemanticDebugCall>;
  readonly finalOutcome: 'ok' | 'invalid_output';
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
