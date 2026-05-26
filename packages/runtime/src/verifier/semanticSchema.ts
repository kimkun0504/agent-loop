/**
 * Schema definitions for the semantic verifier's per-criterion tool call.
 *
 * Each verifier call judges ONE criterion against the diff. The tool input
 * is a single judgment object — `criterion`, `met`, `reasoning`. There is
 * no array shape on the wire; this is the architectural fix from
 * docs/per-criterion-verifier-refactor.md. The schema's *absence* of a
 * `perCriterion` field is a contract; if a future refactor reintroduces
 * the array shape, semanticSchema.test.ts regression test #13 catches it.
 *
 * The aggregator in runSemanticVerifier collects N single-judgment
 * responses into the `Verdict.semanticCheck.perCriterion` array that
 * downstream consumers expect. Aggregation lives in TS code, not in
 * the wire format.
 */

export const SEMANTIC_TOOL_NAME = 'submit_verdict';

export interface PerCriterionJudgment {
  readonly criterion: string;
  readonly met: boolean;
  readonly reasoning: string;
}

/** The shape of a single tool call's input. One judgment per call. */
export const SEMANTIC_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    criterion: { type: 'string', minLength: 1 },
    met: { type: 'boolean' },
    reasoning: { type: 'string', minLength: 1, maxLength: 500 },
  },
  required: ['criterion', 'met', 'reasoning'],
  additionalProperties: false,
};

/**
 * A per-criterion verifier failure (SDK error, invalid output twice, or
 * skipped via onSdkError option). Surfaced in SemanticVerifierResult.
 * The aggregator preserves these so the verdict's reasoning string can
 * cite specific failing criteria.
 */
export interface VerifierError {
  readonly criterion: string;
  readonly reason: 'sdk_error' | 'invalid_output' | 'skipped';
  readonly message: string;
}

/**
 * Debug artifact written when ANY per-criterion call fails validation.
 * Captures ALL calls (successful + failed) because the diagnostic value
 * is cross-call comparison within a task — same diff, same system prompt,
 * different criterion outcomes. See refinement A in
 * docs/per-criterion-verifier-refactor.md.
 *
 * No artifact written when all calls succeed; their judgments are
 * already in verdict-NNN.json.
 */
export interface SemanticDebugCall {
  /** 0-based index into the task's acceptanceCriteria. */
  readonly criterionIndex: number;
  /** The criterion text this call was judging. */
  readonly criterion: string;
  /** The user prompt sent on this call (initial or retry). */
  readonly userPrompt: string;
  /** The literal `input` from the model's tool_use block. */
  readonly rawToolInput: unknown;
  /** Outcome of validation for this call. ok:true means accepted; ok:false captures the reason + validator errors. */
  readonly validatorOutcome:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'sdk_error' | 'invalid_output'; readonly errors: ReadonlyArray<string> };
}

export interface SemanticDebug {
  readonly systemPrompt: string;
  readonly calls: ReadonlyArray<SemanticDebugCall>;
}
