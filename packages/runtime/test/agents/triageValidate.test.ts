import { describe, expect, it } from 'vitest';
import { validateTriageOutput } from '../../src/agents/triageValidate.js';

const validSpec = {
  kind: 'spec',
  spec: {
    title: 'Add foo',
    description: 'Add a foo function that does bar.',
    fileScope: ['src/foo.js', 'test/foo.test.js'],
    acceptanceCriteria: ['foo(1) === 1', 'tests pass'],
    testCommands: ['npm test'],
  },
};

const validRejection = {
  kind: 'rejection',
  rejection: {
    reason: 'too_vague',
    message: 'Could not infer testable criteria.',
    clarifyingQuestions: ['Which file?', 'What metric?'],
  },
};

describe('validateTriageOutput: structural', () => {
  it('rejects non-object input', () => {
    const r = validateTriageOutput('not an object');
    expect('errors' in r).toBe(true);
  });

  it('rejects an unknown kind', () => {
    const r = validateTriageOutput({ kind: 'mystery' });
    expect('errors' in r).toBe(true);
  });

  it('rejects null input', () => {
    expect('errors' in validateTriageOutput(null)).toBe(true);
  });
});

describe('validateTriageOutput: spec branch', () => {
  it('accepts a fully-populated spec', () => {
    const r = validateTriageOutput(validSpec);
    expect('errors' in r).toBe(false);
    if (!('errors' in r) && r.kind === 'spec') {
      expect(r.spec.title).toBe('Add foo');
      expect(r.spec.fileScope).toEqual(['src/foo.js', 'test/foo.test.js']);
    }
  });

  it('rejects when spec field is missing', () => {
    const r = validateTriageOutput({ kind: 'spec' });
    expect('errors' in r).toBe(true);
  });

  it('rejects an empty title', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, title: '' },
    });
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors.join(',')).toMatch(/title/);
    }
  });

  it('rejects an empty fileScope', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, fileScope: [] },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects the forbidden ["**/*"] catch-all scope', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, fileScope: ['**/*'] },
    });
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors.join(',')).toMatch(/catch-all/);
    }
  });

  it('rejects ["**"], ["*"], ["*.*"] as catch-alls too', () => {
    for (const bad of ['**', '*', '*.*']) {
      const r = validateTriageOutput({
        ...validSpec,
        spec: { ...validSpec.spec, fileScope: [bad] },
      });
      expect('errors' in r, `expected error for fileScope=[${bad}]`).toBe(true);
    }
  });

  it('rejects an empty acceptanceCriteria array', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, acceptanceCriteria: [] },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects more than 12 acceptance criteria', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        acceptanceCriteria: Array.from({ length: 13 }, (_, i) => `ac${i}`),
      },
    });
    expect('errors' in r).toBe(true);
  });

  it('accepts empty testCommands (docs-only or semantic-only tasks)', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, testCommands: [] },
    });
    expect('errors' in r).toBe(false);
  });

  it('rejects more than 5 testCommands', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        // 6 vocabulary commands — over the maxItems:5 limit even though
        // each is individually valid.
        testCommands: [
          'npm test',
          'npm run typecheck',
          'npm run lint',
          'npm run build',
          'pnpm test',
          'pnpm typecheck',
        ],
      },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects testCommands outside the documented vocabulary', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        testCommands: ['npm test', "! grep -rE 'foo\\b' src/"],
      },
    });
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/outside the allowed vocabulary/);
      expect(r.errors[0]).toMatch(/move file-state assertions/i);
    }
  });

  it('rejects git diff guards in testCommands (architecturally invalid)', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        testCommands: ['npm test', 'git diff --quiet main -- src/'],
      },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects array entries that are not strings', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, fileScope: ['src/x.js', 42] },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects titles longer than 200 chars', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, title: 'a'.repeat(201) },
    });
    expect('errors' in r).toBe(true);
  });
});

describe('validateTriageOutput: rejection branch', () => {
  it('accepts a valid too_vague rejection with clarifying questions', () => {
    const r = validateTriageOutput(validRejection);
    expect('errors' in r).toBe(false);
    if (!('errors' in r) && r.kind === 'rejection') {
      expect(r.reason).toBe('too_vague');
      expect(r.clarifyingQuestions).toEqual(['Which file?', 'What metric?']);
    }
  });

  it('accepts a not_actionable rejection without clarifyingQuestions', () => {
    const r = validateTriageOutput({
      kind: 'rejection',
      rejection: { reason: 'not_actionable', message: 'Design discussion, not code.' },
    });
    expect('errors' in r).toBe(false);
  });

  it('rejects when rejection field is missing', () => {
    expect('errors' in validateTriageOutput({ kind: 'rejection' })).toBe(true);
  });

  it('rejects an unknown reason', () => {
    const r = validateTriageOutput({
      kind: 'rejection',
      rejection: { reason: 'i_dont_feel_like_it', message: 'meh' },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects an empty message', () => {
    const r = validateTriageOutput({
      kind: 'rejection',
      rejection: { reason: 'too_vague', message: '' },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects non-string clarifyingQuestions entries', () => {
    const r = validateTriageOutput({
      kind: 'rejection',
      rejection: { reason: 'too_vague', message: 'm', clarifyingQuestions: [1, 2] },
    });
    expect('errors' in r).toBe(true);
  });
});

describe('validateTriageOutput: fileStateChecks (Option E)', () => {
  it('accepts all 4 valid types', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        fileStateChecks: [
          { type: 'unchanged', path: 'src/foo.js' },
          { type: 'deleted', path: 'src/old.js' },
          { type: 'exists', path: 'src/new.js' },
          { type: 'absent', path: 'src/never.js' },
        ],
      },
    });
    expect('errors' in r).toBe(false);
    if (!('errors' in r) && r.kind === 'spec') {
      expect(r.spec.fileStateChecks).toHaveLength(4);
    }
  });

  it('accepts spec with no fileStateChecks field (backward compat)', () => {
    const r = validateTriageOutput(validSpec);
    expect('errors' in r).toBe(false);
    if (!('errors' in r) && r.kind === 'spec') {
      expect(r.spec.fileStateChecks).toBeUndefined();
    }
  });

  it('accepts empty fileStateChecks array', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, fileStateChecks: [] },
    });
    expect('errors' in r).toBe(false);
  });

  it('rejects unknown type', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        fileStateChecks: [{ type: 'modified', path: 'src/foo.js' }],
      },
    });
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors[0]).toMatch(/type: must be one of/);
    }
  });

  it('rejects missing path', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        fileStateChecks: [{ type: 'unchanged' }],
      },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects empty path', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        fileStateChecks: [{ type: 'unchanged', path: '' }],
      },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects non-array fileStateChecks', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: { ...validSpec.spec, fileStateChecks: 'oops' },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects non-object entry', () => {
    const r = validateTriageOutput({
      ...validSpec,
      spec: {
        ...validSpec.spec,
        fileStateChecks: ['unchanged: src/foo.js'],
      },
    });
    expect('errors' in r).toBe(true);
  });
});
