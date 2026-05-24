import { describe, expect, it } from 'vitest';
import { validatePlannerOutput } from '../../src/agents/plannerValidate.js';

const validPlan = {
  kind: 'plan',
  plan: {
    filesToTouch: [
      { path: 'src/foo.js', action: 'modify', reason: 'add the new export' },
    ],
    approach: 'add a function to src/foo.js and export it.',
    risks: [],
    testStrategy: 'run npm test; the new function has dedicated tests.',
  },
};

describe('validatePlannerOutput: structural', () => {
  it('rejects non-object input', () => {
    expect('errors' in validatePlannerOutput('not json')).toBe(true);
  });
  it('rejects unknown kind', () => {
    expect('errors' in validatePlannerOutput({ kind: 'maybe' })).toBe(true);
  });
});

describe('validatePlannerOutput: plan branch', () => {
  it('accepts a fully-populated plan', () => {
    const r = validatePlannerOutput(validPlan);
    expect('errors' in r).toBe(false);
    if (!('errors' in r) && r.kind === 'plan') {
      expect(r.plan.filesToTouch).toHaveLength(1);
      expect(r.plan.filesToTouch[0]?.action).toBe('modify');
    }
  });

  it('rejects missing plan object', () => {
    expect('errors' in validatePlannerOutput({ kind: 'plan' })).toBe(true);
  });

  it('rejects empty filesToTouch', () => {
    const r = validatePlannerOutput({
      ...validPlan,
      plan: { ...validPlan.plan, filesToTouch: [] },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects an invalid action', () => {
    const r = validatePlannerOutput({
      ...validPlan,
      plan: {
        ...validPlan.plan,
        filesToTouch: [
          { path: 'src/x.js', action: 'rename', reason: 'r' },
        ],
      },
    });
    expect('errors' in r).toBe(true);
    if ('errors' in r) {
      expect(r.errors.join(',')).toMatch(/action must be one of/);
    }
  });

  it('rejects empty path / reason', () => {
    const r = validatePlannerOutput({
      ...validPlan,
      plan: {
        ...validPlan.plan,
        filesToTouch: [{ path: '', action: 'modify', reason: 'r' }],
      },
    });
    expect('errors' in r).toBe(true);
  });

  it('accepts an empty risks array (low-risk changes are valid)', () => {
    const r = validatePlannerOutput(validPlan);
    expect('errors' in r).toBe(false);
  });

  it('rejects risks that is not an array', () => {
    const r = validatePlannerOutput({
      ...validPlan,
      plan: { ...validPlan.plan, risks: 'no risks' },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects empty approach', () => {
    const r = validatePlannerOutput({
      ...validPlan,
      plan: { ...validPlan.plan, approach: '' },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects empty testStrategy', () => {
    const r = validatePlannerOutput({
      ...validPlan,
      plan: { ...validPlan.plan, testStrategy: '' },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects more than 30 files', () => {
    const r = validatePlannerOutput({
      ...validPlan,
      plan: {
        ...validPlan.plan,
        filesToTouch: Array.from({ length: 31 }, (_, i) => ({
          path: `src/f${i}.js`,
          action: 'modify',
          reason: 'r',
        })),
      },
    });
    expect('errors' in r).toBe(true);
  });
});

describe('validatePlannerOutput: rejection branch', () => {
  it('accepts unimplementable rejection', () => {
    const r = validatePlannerOutput({
      kind: 'rejection',
      rejection: {
        reason: 'unimplementable',
        message: 'spec references files that do not exist',
      },
    });
    expect('errors' in r).toBe(false);
  });

  it('rejects unknown rejection reason', () => {
    const r = validatePlannerOutput({
      kind: 'rejection',
      rejection: { reason: 'too_vague', message: 'm' },
    });
    expect('errors' in r).toBe(true);
  });

  it('rejects empty message', () => {
    const r = validatePlannerOutput({
      kind: 'rejection',
      rejection: { reason: 'unimplementable', message: '' },
    });
    expect('errors' in r).toBe(true);
  });
});
