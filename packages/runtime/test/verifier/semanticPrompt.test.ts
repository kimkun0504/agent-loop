import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_SYSTEM_PROMPT,
  buildSemanticUserPrompt,
  buildSemanticRetryUserPrompt,
} from '../../src/verifier/semanticPrompt.js';

describe('SEMANTIC_SYSTEM_PROMPT', () => {
  it('contains the bias-toward-strictness instruction', () => {
    expect(SEMANTIC_SYSTEM_PROMPT.toLowerCase()).toContain('when in doubt');
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('mark `met: false`');
  });

  it('instructs verbatim echo of the criterion string', () => {
    expect(SEMANTIC_SYSTEM_PROMPT.toLowerCase()).toContain('verbatim');
    expect(SEMANTIC_SYSTEM_PROMPT.toLowerCase()).toContain('do not paraphrase');
  });

  it('explicitly forbids the array/wrap/stringify shapes', () => {
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('Do NOT wrap the judgment in an array');
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('Do NOT stringify the judgment');
  });

  it('contains both worked examples', () => {
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('Example 1');
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('Example 2');
  });

  it('example 1 includes a borderline judgment (returns null vs throws)', () => {
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('returns `null`');
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('does not throw');
  });

  it('contains the deletion-hunk clarification', () => {
    expect(SEMANTIC_SYSTEM_PROMPT.toLowerCase()).toContain('deletion hunks');
    expect(SEMANTIC_SYSTEM_PROMPT.toLowerCase()).toContain(
      'count as "touching" a path',
    );
  });

  it('declares the diff as the universe of changes', () => {
    expect(SEMANTIC_SYSTEM_PROMPT).toContain(
      'diff IS the universe of changes',
    );
  });

  it('forces the submit_verdict tool call', () => {
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('submit_verdict');
    expect(SEMANTIC_SYSTEM_PROMPT.toLowerCase()).toContain(
      'never respond with prose',
    );
  });

  it('describes single-judgment shape (no array language in the worked examples)', () => {
    // The worked examples should show single judgment objects, not arrays.
    // Their tool-call blocks should NOT contain "perCriterion".
    expect(SEMANTIC_SYSTEM_PROMPT).not.toMatch(/"perCriterion"/);
  });
});

describe('buildSemanticUserPrompt', () => {
  it('wraps the diff in a fenced # Diff block in the cached prefix', () => {
    const out = buildSemanticUserPrompt('some diff text', 'c1');
    expect(out.cachedPrefix).toContain('# Diff');
    expect(out.cachedPrefix).toMatch(/```\nsome diff text\n```/);
  });

  it('places the criterion in the suffix (after the cache breakpoint)', () => {
    const out = buildSemanticUserPrompt('d', 'foo is bar');
    expect(out.criterionSuffix).toContain('# Acceptance criterion');
    expect(out.criterionSuffix).toContain('foo is bar');
    // The criterion must NOT appear in the cached prefix; if it did,
    // the cache would invalidate per call (criterion varies).
    expect(out.cachedPrefix).not.toContain('foo is bar');
  });

  it('instructs the model to echo the criterion verbatim and not stringify', () => {
    const out = buildSemanticUserPrompt('d', 'c');
    expect(out.criterionSuffix).toContain('Echo the criterion string verbatim');
    expect(out.criterionSuffix).toMatch(/not an array/);
    expect(out.criterionSuffix).toMatch(/not.*stringified/);
  });
});

describe('buildSemanticRetryUserPrompt', () => {
  it('inlines the validator errors as a bulleted list', () => {
    const out = buildSemanticRetryUserPrompt('d', 'c', [
      'met: missing or not a boolean',
      'criterion not echoed verbatim',
    ]);
    expect(out.criterionSuffix).toContain('# Your previous response had validation errors');
    expect(out.criterionSuffix).toContain('- met: missing or not a boolean');
    expect(out.criterionSuffix).toContain('- criterion not echoed verbatim');
  });

  it('includes the single-judgment shape reminder (not array, not stringified)', () => {
    const out = buildSemanticRetryUserPrompt('d', 'c', ['e']);
    expect(out.criterionSuffix).toMatch(/ONE object/);
    expect(out.criterionSuffix).toMatch(/criterion.*met.*reasoning/);
    expect(out.criterionSuffix).toMatch(/Do not wrap in an array/);
    expect(out.criterionSuffix).toMatch(/Do not stringify/);
  });

  it('reiterates the verbatim-echo instruction in the retry', () => {
    const out = buildSemanticRetryUserPrompt('d', 'c', ['e']);
    expect(out.criterionSuffix).toContain('Echo the criterion string verbatim');
    expect(out.criterionSuffix.toLowerCase()).toContain('do not paraphrase');
  });

  it('shares the same cachedPrefix as the initial prompt for the same diff', () => {
    const initial = buildSemanticUserPrompt('d', 'c1');
    const retry = buildSemanticRetryUserPrompt('d', 'c1', ['e']);
    expect(retry.cachedPrefix).toBe(initial.cachedPrefix);
  });
});
