import { describe, expect, it } from 'vitest';
import { validateSingleJudgment } from '../../src/verifier/semanticValidate.js';
import { SEMANTIC_INPUT_SCHEMA } from '../../src/verifier/semanticSchema.js';

const expectedCriterion = 'foo is bar';

function valid(): unknown {
  return { criterion: 'foo is bar', met: true, reasoning: 'ev1' };
}

describe('validateSingleJudgment: happy path', () => {
  it('accepts a valid single judgment', () => {
    const r = validateSingleJudgment(valid(), expectedCriterion);
    expect('judgment' in r).toBe(true);
    if ('judgment' in r) {
      expect(r.judgment.criterion).toBe('foo is bar');
      expect(r.judgment.met).toBe(true);
      expect(r.judgment.reasoning).toBe('ev1');
    }
  });

  it('accepts whitespace-only differences in the criterion echo', () => {
    const r = validateSingleJudgment(
      { criterion: 'foo  is bar', met: true, reasoning: 'r' },
      expectedCriterion,
    );
    expect('judgment' in r).toBe(true);
  });

  it('accepts trailing-punctuation strip on the criterion echo', () => {
    const r = validateSingleJudgment(
      { criterion: 'foo is bar.', met: false, reasoning: 'r' },
      expectedCriterion,
    );
    expect('judgment' in r).toBe(true);
  });
});

describe('validateSingleJudgment: structural rejections', () => {
  it('rejects null input', () => {
    expect('errors' in validateSingleJudgment(null, expectedCriterion)).toBe(true);
  });

  it('rejects non-object input', () => {
    expect('errors' in validateSingleJudgment('string', expectedCriterion)).toBe(true);
    expect('errors' in validateSingleJudgment(42, expectedCriterion)).toBe(true);
  });

  it('rejects array input (would have been the OLD shape)', () => {
    const r = validateSingleJudgment(
      [{ criterion: 'foo is bar', met: true, reasoning: 'r' }],
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/not an object/);
    }
  });

  it('rejects missing criterion', () => {
    const r = validateSingleJudgment(
      { met: true, reasoning: 'r' },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/criterion/);
    }
  });

  it('rejects empty criterion', () => {
    const r = validateSingleJudgment(
      { criterion: '', met: true, reasoning: 'r' },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects missing met', () => {
    const r = validateSingleJudgment(
      { criterion: 'foo is bar', reasoning: 'r' },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/met/);
    }
  });

  it('rejects non-boolean met', () => {
    const r = validateSingleJudgment(
      { criterion: 'foo is bar', met: 'yes', reasoning: 'r' },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects missing reasoning', () => {
    const r = validateSingleJudgment(
      { criterion: 'foo is bar', met: true },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects empty reasoning', () => {
    const r = validateSingleJudgment(
      { criterion: 'foo is bar', met: true, reasoning: '' },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects reasoning over 500 chars', () => {
    const long = 'x'.repeat(501);
    const r = validateSingleJudgment(
      { criterion: 'foo is bar', met: true, reasoning: long },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/exceeds 500 limit/);
    }
  });
});

describe('validateSingleJudgment: strict criterion-echo policy', () => {
  it('rejects when model paraphrases the criterion', () => {
    // expected: "foo is bar"; model returned: "foo equals bar"
    const r = validateSingleJudgment(
      { criterion: 'foo equals bar', met: true, reasoning: 'r' },
      expectedCriterion,
    );
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/not echoed verbatim/);
      expect(r.errors[0]).toMatch(/Paraphrasing is rejected/);
    }
  });

  it('rejects when model truncates the criterion', () => {
    // expected: "foo is bar (with detail)"; model returned: "foo is bar"
    const r = validateSingleJudgment(
      { criterion: 'foo is bar', met: true, reasoning: 'r' },
      'foo is bar (with detail)',
    );
    expect('errors' in r).toBe(true);
  });
});

describe('SEMANTIC_INPUT_SCHEMA regression guard', () => {
  // Refinement C from docs/per-criterion-verifier-refactor.md:
  // the schema is the contract that prevents the array-shape failure
  // class. If a future refactor accidentally reintroduces the array
  // shape, this test catches it.
  it('does NOT contain a perCriterion field', () => {
    const props = (SEMANTIC_INPUT_SCHEMA as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('perCriterion');
  });

  it('has criterion, met, reasoning as top-level required fields', () => {
    const schema = SEMANTIC_INPUT_SCHEMA as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty('criterion');
    expect(schema.properties).toHaveProperty('met');
    expect(schema.properties).toHaveProperty('reasoning');
    expect(schema.required).toEqual(['criterion', 'met', 'reasoning']);
  });
});
