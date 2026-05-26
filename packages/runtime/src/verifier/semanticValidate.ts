/**
 * Hand-rolled validator for a single per-criterion verifier judgment.
 *
 * The strict-match policy for the `criterion` string still applies — the
 * model must echo the input criterion verbatim (after whitespace
 * normalization and trailing-punctuation stripping). Paraphrase is
 * rejected. The policy is load-bearing for the same reason as before:
 * a paraphrased criterion is a paraphrased judgment, and rubber-stamping
 * hides most easily in paraphrase.
 *
 * The array-shape accommodation from the previous validator is gone —
 * not by explicit removal, but by absence. The new validator has no
 * array path. See docs/per-criterion-verifier-refactor.md step 9.
 */

import type { PerCriterionJudgment } from './semanticSchema.js';

export type SemanticValidationResult =
  | { errors: string[] }
  | { judgment: PerCriterionJudgment };

export function validateSingleJudgment(
  raw: unknown,
  expectedCriterion: string,
): SemanticValidationResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['tool input is not an object'] };
  }
  const obj = raw as Record<string, unknown>;

  const errors: string[] = [];
  const criterion = obj['criterion'];
  const met = obj['met'];
  const reasoning = obj['reasoning'];

  if (typeof criterion !== 'string' || criterion.length === 0) {
    errors.push('criterion: missing or empty string');
  }
  if (typeof met !== 'boolean') {
    errors.push('met: missing or not a boolean');
  }
  if (typeof reasoning !== 'string' || reasoning.length === 0) {
    errors.push('reasoning: missing or empty string');
  } else if (reasoning.length > 500) {
    errors.push(`reasoning: ${reasoning.length} chars exceeds 500 limit`);
  }

  if (errors.length > 0) return { errors };

  // Strict-match: model must echo the input criterion verbatim
  // (after whitespace normalize + trailing-punctuation strip).
  if (typeof criterion === 'string' && normalize(criterion) !== normalize(expectedCriterion)) {
    return {
      errors: [
        `criterion not echoed verbatim: expected "${expectedCriterion}", got "${criterion}". Paraphrasing is rejected — echo the criterion string exactly.`,
      ],
    };
  }

  return {
    judgment: {
      criterion: criterion as string,
      met: met as boolean,
      reasoning: reasoning as string,
    },
  };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/[.,;!?]+$/, '');
}
