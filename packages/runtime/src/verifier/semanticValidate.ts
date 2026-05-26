/**
 * Hand-rolled validator for the semantic verifier's tool output.
 *
 * The strict-match policy for `criterion` strings is load-bearing: a
 * paraphrased criterion is a paraphrased *judgment*, and the human
 * reviewer downstream has to mentally re-bind the paraphrase to the
 * original — exactly the failure mode where rubber-stamping hides.
 * Whitespace is normalized and trailing punctuation stripped before
 * comparison, but otherwise we require verbatim echo. Case-sensitive
 * because acceptance criteria flow through the system as exact strings
 * (triage authored, no human re-typing in between).
 */

import type {
  PerCriterionJudgment,
  SemanticVerdictPayload,
} from './semanticSchema.js';

export type SemanticValidationResult =
  | { errors: string[] }
  | { payload: SemanticVerdictPayload };

export function validateSemanticOutput(
  raw: unknown,
  inputCriteria: ReadonlyArray<string>,
): SemanticValidationResult {
  const errors: string[] = [];

  if (raw === null || typeof raw !== 'object') {
    return { errors: ['tool input is not an object'] };
  }
  const obj = raw as Record<string, unknown>;

  if (!('perCriterion' in obj)) {
    return { errors: ['missing field: perCriterion'] };
  }
  let list = obj['perCriterion'];

  // Wire-format accommodation: Sonnet 4.6 was observed (CHECKPOINT 3
  // re-runs, split-module task) producing perCriterion as a STRING
  // containing a JSON-encoded array. Both calls of the retry loop
  // produced the same shape even after an explicit "do not stringify
  // the array" instruction in the retry prompt. The substantive
  // judgments inside the stringified array were correct (criteria,
  // met booleans, reasoning all well-formed); only the wire format
  // was wrong. We accept stringified arrays by parsing them and
  // re-validating as if the model had returned an array directly.
  //
  // This is ACCOMMODATION, not endorsement. The long-term answer is
  // Option C from gap-triage-testcommand-pattern-debt — per-criterion
  // verifier calls that avoid the array shape entirely. Tracked as
  // BACKLOG#polish-validator-stringified-array-accommodation. If the
  // accommodation produces calibration issues (e.g., enabling some
  // failure mode we can't see yet), revisit and tighten.
  if (typeof list === 'string') {
    try {
      const parsed: unknown = JSON.parse(list);
      if (Array.isArray(parsed)) {
        list = parsed;
      }
    } catch {
      // Fall through to the not-an-array rejection below.
    }
  }

  if (!Array.isArray(list)) {
    return { errors: ['perCriterion is not an array'] };
  }
  if (list.length === 0) {
    return { errors: ['perCriterion is empty; expected at least one entry'] };
  }

  const judgments: PerCriterionJudgment[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (entry === null || typeof entry !== 'object') {
      errors.push(`perCriterion[${i}]: not an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const criterion = e['criterion'];
    const met = e['met'];
    const reasoning = e['reasoning'];

    if (typeof criterion !== 'string' || criterion.length === 0) {
      errors.push(`perCriterion[${i}].criterion: missing or empty string`);
    }
    if (typeof met !== 'boolean') {
      errors.push(`perCriterion[${i}].met: missing or not a boolean`);
    }
    if (typeof reasoning !== 'string' || reasoning.length === 0) {
      errors.push(`perCriterion[${i}].reasoning: missing or empty string`);
    } else if (reasoning.length > 500) {
      errors.push(
        `perCriterion[${i}].reasoning: ${reasoning.length} chars exceeds 500 limit`,
      );
    }

    if (
      typeof criterion === 'string' &&
      typeof met === 'boolean' &&
      typeof reasoning === 'string' &&
      reasoning.length > 0 &&
      reasoning.length <= 500 &&
      criterion.length > 0
    ) {
      judgments.push({ criterion, met, reasoning });
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  const matchErrors = checkCriteriaCoverage(judgments, inputCriteria);
  if (matchErrors.length > 0) {
    return { errors: matchErrors };
  }

  return { payload: { perCriterion: judgments } };
}

/**
 * Strict-match policy: every input criterion must appear (exactly,
 * after normalize) in the output. Paraphrase is rejected — the
 * "did you echo verbatim?" check is the one place rubber-stamping
 * is most likely to leak past the validator otherwise.
 */
function checkCriteriaCoverage(
  judgments: ReadonlyArray<PerCriterionJudgment>,
  inputCriteria: ReadonlyArray<string>,
): string[] {
  const errors: string[] = [];
  const judgedNormalized = new Set(judgments.map((j) => normalize(j.criterion)));
  const inputNormalized = inputCriteria.map(normalize);

  for (let i = 0; i < inputNormalized.length; i++) {
    const want = inputNormalized[i];
    if (want === undefined) continue;
    if (!judgedNormalized.has(want)) {
      errors.push(
        `criterion ${i + 1} not echoed verbatim in output: "${inputCriteria[i]}". Paraphrasing is rejected — echo the criterion string exactly.`,
      );
    }
  }
  return errors;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/[.,;!?]+$/, '');
}
