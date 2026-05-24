import { describe, expect, it } from 'vitest';
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
  buildPlannerRetryUserPrompt,
} from '../../src/agents/plannerPrompt.js';
import {
  RunId,
  SpecId,
  DEFAULT_BUDGET,
  type Spec,
} from '@agent-loop/core';
import type {
  FileContentSnapshot,
  RepoContextSnapshot,
} from '../../src/agents/repoContext.js';

const blankCtx: RepoContextSnapshot = {
  tree: '',
  readme: '',
  packageJson: '',
  claudeMd: '',
  totalBytes: 0,
  capsUsed: { tree: 0, readme: 0, packageJson: 0, claudeMd: 0 },
};

function sampleSpec(): Spec {
  return {
    id: SpecId('spec-1'),
    runId: RunId('run-1'),
    title: 'Add foo helper',
    description: 'Add a foo function to src/foo.js.',
    fileScope: ['src/foo.js'],
    acceptanceCriteria: ['foo(1) returns 1', 'tests pass'],
    testCommands: ['npm test'],
    budget: DEFAULT_BUDGET,
    createdAt: '2026-05-24T00:00:00.000Z',
  };
}

describe('PLANNER_SYSTEM_PROMPT', () => {
  it('names the tool and both kinds', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('submit_plan_result');
    expect(PLANNER_SYSTEM_PROMPT).toContain('"plan"');
    expect(PLANNER_SYSTEM_PROMPT).toContain('"rejection"');
  });

  it('explicitly forbids inventing risks', () => {
    expect(PLANNER_SYSTEM_PROMPT.toLowerCase()).toContain('do not invent risks');
  });

  it('mentions file ordering as a real concern for cross-file changes', () => {
    expect(PLANNER_SYSTEM_PROMPT.toLowerCase()).toContain('order matters');
  });

  it('includes both worked examples (additive + cross-file rename)', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('Example A');
    expect(PLANNER_SYSTEM_PROMPT).toContain('Example B');
    // The B example is the cross-file rename — the planner-leverage case.
    expect(PLANNER_SYSTEM_PROMPT).toContain('Rename oldName to newName');
    expect(PLANNER_SYSTEM_PROMPT).toContain('rename the export first');
  });

  it('restricts rejection to "unimplementable" only', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('unimplementable');
    // Planner does NOT have triage-style too_vague / not_actionable.
    expect(PLANNER_SYSTEM_PROMPT.toLowerCase()).not.toContain('too_vague');
  });
});

describe('buildPlannerUserPrompt', () => {
  it('renders the spec as a labelled block at the top', () => {
    const p = buildPlannerUserPrompt(sampleSpec(), blankCtx, []);
    expect(p).toContain('# Spec');
    expect(p).toContain('Add foo helper');
    expect(p).toContain('src/foo.js');
  });

  it('includes file contents when provided', () => {
    const files: FileContentSnapshot[] = [
      {
        path: 'src/foo.js',
        content: 'export const foo = () => 1;',
        lines: 1,
        omitted: false,
        truncated: false,
      },
    ];
    const p = buildPlannerUserPrompt(sampleSpec(), blankCtx, files);
    expect(p).toContain('## File contents');
    expect(p).toContain('### src/foo.js');
    expect(p).toContain('export const foo');
  });

  it('marks omitted files explicitly when context cap is reached', () => {
    const files: FileContentSnapshot[] = [
      { path: 'src/a.js', content: 'x', lines: 1, omitted: false, truncated: false },
      { path: 'src/b.js', content: '', lines: 0, omitted: true, truncated: false },
    ];
    const p = buildPlannerUserPrompt(sampleSpec(), blankCtx, files);
    expect(p).toContain('### src/a.js');
    expect(p).toContain('### src/b.js (omitted');
  });

  it('marks truncated files with a (truncated) suffix', () => {
    const files: FileContentSnapshot[] = [
      { path: 'src/big.js', content: 'huge content ...', lines: 1, omitted: false, truncated: true },
    ];
    const p = buildPlannerUserPrompt(sampleSpec(), blankCtx, files);
    expect(p).toContain('### src/big.js (truncated)');
  });
});

describe('buildPlannerRetryUserPrompt', () => {
  it('inlines the validator errors and tells the model not to explain', () => {
    const p = buildPlannerRetryUserPrompt('original prompt', [
      'filesToTouch must be a non-empty array',
    ]);
    expect(p).toContain('original prompt');
    expect(p).toContain('filesToTouch must be a non-empty array');
    expect(p.toLowerCase()).toContain('do not explain');
  });
});
