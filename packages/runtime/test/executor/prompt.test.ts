import { describe, expect, it } from 'vitest';
import {
  type Spec,
  RunId,
  SpecId,
  DEFAULT_BUDGET,
} from '@agent-loop/core';
import { buildExecutorPrompt } from '../../src/executor/prompt.js';

function specWith(overrides: Partial<Spec> = {}): Spec {
  return {
    id: SpecId('spec-1'),
    runId: RunId('run-1'),
    title: 'Add a passing test for the foo function',
    description: 'The foo function in src/foo.ts needs a unit test.',
    fileScope: ['src/foo.ts', 'test/foo.test.ts'],
    acceptanceCriteria: [
      'A test file exists at test/foo.test.ts',
      'Running `pnpm test` exits 0',
    ],
    testCommands: ['pnpm test', 'pnpm typecheck'],
    budget: DEFAULT_BUDGET,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildExecutorPrompt', () => {
  it('includes the title prominently', () => {
    const p = buildExecutorPrompt(specWith());
    expect(p).toContain('Add a passing test for the foo function');
  });

  it('includes the description', () => {
    const p = buildExecutorPrompt(specWith());
    expect(p).toContain('The foo function in src/foo.ts needs a unit test.');
  });

  it('lists every acceptance criterion', () => {
    const p = buildExecutorPrompt(specWith());
    expect(p).toContain('A test file exists at test/foo.test.ts');
    expect(p).toContain('Running `pnpm test` exits 0');
  });

  it('lists every file scope entry', () => {
    const p = buildExecutorPrompt(specWith());
    expect(p).toContain('src/foo.ts');
    expect(p).toContain('test/foo.test.ts');
  });

  it('lists every test command (the agent should make these pass)', () => {
    const p = buildExecutorPrompt(specWith());
    expect(p).toContain('pnpm test');
    expect(p).toContain('pnpm typecheck');
  });

  it('omits the acceptance section when there are no criteria', () => {
    const p = buildExecutorPrompt(specWith({ acceptanceCriteria: [] }));
    expect(p).not.toContain('Acceptance criteria');
  });

  it('omits the file scope section when scope is empty', () => {
    const p = buildExecutorPrompt(specWith({ fileScope: [] }));
    expect(p).not.toContain('Allowed file scope');
  });

  it('omits the verification section when there are no test commands', () => {
    const p = buildExecutorPrompt(specWith({ testCommands: [] }));
    expect(p).not.toContain('How your work will be verified');
  });
});
