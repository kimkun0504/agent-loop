import { describe, expect, it } from 'vitest';
import { validateSemanticOutput } from '../../src/verifier/semanticValidate.js';

const criteria = ['foo is bar', 'baz is qux'];

function valid(): unknown {
  return {
    perCriterion: [
      { criterion: 'foo is bar', met: true, reasoning: 'ev1' },
      { criterion: 'baz is qux', met: false, reasoning: 'ev2' },
    ],
  };
}

describe('validateSemanticOutput: happy path', () => {
  it('accepts a valid per-criterion array', () => {
    const r = validateSemanticOutput(valid(), criteria);
    expect('payload' in r).toBe(true);
    if ('payload' in r) {
      expect(r.payload.perCriterion).toHaveLength(2);
      expect(r.payload.perCriterion[0]?.met).toBe(true);
    }
  });

  it('accepts when output reorders criteria from input', () => {
    const reordered = {
      perCriterion: [
        { criterion: 'baz is qux', met: false, reasoning: 'ev2' },
        { criterion: 'foo is bar', met: true, reasoning: 'ev1' },
      ],
    };
    const r = validateSemanticOutput(reordered, criteria);
    expect('payload' in r).toBe(true);
  });

  it('accepts whitespace-only differences and strips trailing punctuation', () => {
    const out = {
      perCriterion: [
        { criterion: 'foo  is bar.', met: true, reasoning: 'ev1' },
        { criterion: 'baz is qux', met: false, reasoning: 'ev2' },
      ],
    };
    const r = validateSemanticOutput(out, criteria);
    expect('payload' in r).toBe(true);
  });
});

describe('validateSemanticOutput: structural rejections', () => {
  it('rejects non-object input', () => {
    expect('errors' in validateSemanticOutput(null, criteria)).toBe(true);
    expect('errors' in validateSemanticOutput('string', criteria)).toBe(true);
    expect('errors' in validateSemanticOutput([], criteria)).toBe(true);
  });

  it('rejects missing perCriterion', () => {
    const r = validateSemanticOutput({}, criteria);
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/missing field: perCriterion/);
    }
  });

  it('rejects perCriterion not an array', () => {
    const r = validateSemanticOutput({ perCriterion: 'oops' }, criteria);
    expect('errors' in r).toBe(true);
  });

  it('rejects empty perCriterion array', () => {
    const r = validateSemanticOutput({ perCriterion: [] }, criteria);
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/empty/);
    }
  });

  it('rejects entry missing criterion', () => {
    const r = validateSemanticOutput(
      {
        perCriterion: [
          { met: true, reasoning: 'r' },
          { criterion: 'baz is qux', met: false, reasoning: 'r' },
        ],
      },
      criteria,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects entry missing met', () => {
    const r = validateSemanticOutput(
      {
        perCriterion: [
          { criterion: 'foo is bar', reasoning: 'r' },
          { criterion: 'baz is qux', met: false, reasoning: 'r' },
        ],
      },
      criteria,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects entry missing reasoning', () => {
    const r = validateSemanticOutput(
      {
        perCriterion: [
          { criterion: 'foo is bar', met: true },
          { criterion: 'baz is qux', met: false, reasoning: 'r' },
        ],
      },
      criteria,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects entry with empty reasoning', () => {
    const r = validateSemanticOutput(
      {
        perCriterion: [
          { criterion: 'foo is bar', met: true, reasoning: '' },
          { criterion: 'baz is qux', met: false, reasoning: 'r' },
        ],
      },
      criteria,
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects entry with reasoning over 500 chars', () => {
    const long = 'x'.repeat(501);
    const r = validateSemanticOutput(
      {
        perCriterion: [
          { criterion: 'foo is bar', met: true, reasoning: long },
          { criterion: 'baz is qux', met: false, reasoning: 'r' },
        ],
      },
      criteria,
    );
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/exceeds 500 limit/);
    }
  });
});

describe('validateSemanticOutput: strict criterion-match policy', () => {
  it('rejects when output omits an input criterion', () => {
    const r = validateSemanticOutput(
      {
        perCriterion: [
          { criterion: 'foo is bar', met: true, reasoning: 'r' },
        ],
      },
      criteria,
    );
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/not echoed verbatim/);
    }
  });

  it('rejects when model paraphrases a criterion (refinement H)', () => {
    // input: "foo is bar (with detail)"; output: "foo is bar"
    const withDetail = ['foo is bar (with detail)', 'baz is qux'];
    const paraphrased = {
      perCriterion: [
        { criterion: 'foo is bar', met: true, reasoning: 'r' },
        { criterion: 'baz is qux', met: false, reasoning: 'r' },
      ],
    };
    const r = validateSemanticOutput(paraphrased, withDetail);
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/not echoed verbatim/);
      expect(r.errors[0]).toMatch(/foo is bar \(with detail\)/);
      expect(r.errors[0]).toMatch(/Paraphrasing is rejected/);
    }
  });
});
