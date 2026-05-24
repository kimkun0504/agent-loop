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

  it('contains both worked examples', () => {
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('Example 1');
    expect(SEMANTIC_SYSTEM_PROMPT).toContain('Example 2');
  });

  it('example 1 includes a borderline judgment in reasoning (returns null vs throws)', () => {
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
});

describe('buildSemanticUserPrompt', () => {
  it('wraps the diff in a fenced # Diff block', () => {
    const out = buildSemanticUserPrompt('some diff text', ['c1']);
    expect(out).toContain('# Diff');
    expect(out).toMatch(/```\nsome diff text\n```/);
  });

  it('numbers criteria starting at 1', () => {
    const out = buildSemanticUserPrompt('d', ['alpha', 'beta', 'gamma']);
    expect(out).toContain('1. alpha');
    expect(out).toContain('2. beta');
    expect(out).toContain('3. gamma');
  });

  it('instructs the model to echo criteria verbatim', () => {
    const out = buildSemanticUserPrompt('d', ['c']);
    expect(out).toContain('Echo each criterion string verbatim');
  });
});

describe('buildSemanticRetryUserPrompt', () => {
  it('inlines the validator errors as a bulleted list', () => {
    const out = buildSemanticRetryUserPrompt('original prompt body', [
      'perCriterion[0].met: missing or not a boolean',
      'criterion 2 not echoed verbatim',
    ]);
    expect(out).toContain('original prompt body');
    expect(out).toContain('# Your previous response had validation errors');
    expect(out).toContain('- perCriterion[0].met: missing or not a boolean');
    expect(out).toContain('- criterion 2 not echoed verbatim');
  });

  it('reiterates the verbatim-echo instruction in the retry', () => {
    const out = buildSemanticRetryUserPrompt('p', ['e']);
    expect(out).toContain('Echo each criterion string verbatim');
    expect(out).toContain('do not paraphrase');
  });
});
