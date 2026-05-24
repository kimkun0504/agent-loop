import { describe, expect, it } from 'vitest';
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriageUserPrompt,
  buildTriageRetryUserPrompt,
} from '../../src/agents/triagePrompt.js';
import type { RepoContextSnapshot } from '../../src/agents/repoContext.js';

const blankCtx: RepoContextSnapshot = {
  tree: '',
  readme: '',
  packageJson: '',
  claudeMd: '',
  totalBytes: 0,
  capsUsed: { tree: 0, readme: 0, packageJson: 0, claudeMd: 0 },
};

describe('TRIAGE_SYSTEM_PROMPT', () => {
  it('names the tool and both kinds', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('submit_triage_result');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"spec"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"rejection"');
  });

  it('lists all three rejection reasons', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('not_actionable');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('too_vague');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('out_of_scope');
  });

  it('warns against the **/* catch-all glob', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('**/*');
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('blank check');
  });

  it('contains all three worked examples', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example A');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example B');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example C');
    // B is the vague-task → rejection example.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Improve the performance');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('too_vague');
    // C is the rename → absence-verification example.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Rename oldName to newName');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('! grep -rE');
  });

  it('teaches the negated-grep pattern for absence verifications', () => {
    // CHECKPOINT 2 surfaced that triage was producing non-negated grep
    // for absence checks (`git grep -l`), inverting the test semantics
    // and breaking rename-export. The prompt now explicitly warns
    // about this pattern and points at the correct form.
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('absence');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('! grep');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('git grep -l');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('word boundary');
  });

  it('teaches grep -q for presence verifications', () => {
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('presence');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('grep -q');
  });
});

describe('buildTriageUserPrompt', () => {
  it('includes the task description verbatim', () => {
    const p = buildTriageUserPrompt('Add a clamp helper.', blankCtx);
    expect(p).toContain('Add a clamp helper.');
  });

  it('omits the title section when no title given', () => {
    const p = buildTriageUserPrompt('body', blankCtx);
    expect(p).not.toContain('# Task title');
  });

  it('includes the title section when one is given', () => {
    const p = buildTriageUserPrompt('body', blankCtx, 'short title');
    expect(p).toContain('# Task title');
    expect(p).toContain('short title');
  });

  it('omits context sections when their content is empty', () => {
    const p = buildTriageUserPrompt('body', blankCtx);
    expect(p).not.toContain('## File tree');
    expect(p).not.toContain('## README.md');
    expect(p).not.toContain('## package.json');
    expect(p).not.toContain('## CLAUDE.md');
  });

  it('includes context sections when populated', () => {
    const p = buildTriageUserPrompt('body', {
      ...blankCtx,
      tree: 'src/\n  index.js',
      readme: '# proj',
      packageJson: '{"name": "x"}',
      claudeMd: '## rules',
    });
    expect(p).toContain('src/');
    expect(p).toContain('# proj');
    expect(p).toContain('"name": "x"');
    expect(p).toContain('## rules');
  });
});

describe('buildTriageRetryUserPrompt', () => {
  it('inlines the original user prompt and the validator errors', () => {
    const p = buildTriageRetryUserPrompt('original prompt text', [
      'fileScope is too broad',
      'title is empty',
    ]);
    expect(p).toContain('original prompt text');
    expect(p).toContain('fileScope is too broad');
    expect(p).toContain('title is empty');
  });

  it('instructs the model to call the tool again, not explain', () => {
    const p = buildTriageRetryUserPrompt('original', ['e']);
    expect(p.toLowerCase()).toContain('do not explain');
  });
});
