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

  it('contains all four worked examples', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example A');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example B');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example C');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example D');
    // B is the vague-task → rejection example.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Improve the performance');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('too_vague');
    // C is the rename, now expressed via natural-language absence claim
    // (the negated-grep shell command has been removed).
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Rename oldName to newName');
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'no occurrence of the token oldName',
    );
    // D is the test-only change, now expressed via natural-language
    // "unchanged" claim (the git-diff shell guard has been removed).
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Add edge-case tests for isValidEmail');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('src/email.js is unchanged');
  });

  it('does not teach triage to author shell verification commands', () => {
    // The old prompt taught negated-grep / grep -q / git diff --quiet
    // patterns as testCommands. Those have been removed; triage now
    // produces only vocabulary testCommands and expresses file-state
    // claims as natural-language acceptanceCriteria. The semantic
    // verifier judges those against the diff.
    expect(TRIAGE_SYSTEM_PROMPT).not.toMatch(
      /"testCommands":\s*\[\s*"npm test",\s*"! grep/,
    );
    expect(TRIAGE_SYSTEM_PROMPT).not.toMatch(
      /"testCommands":\s*\[\s*"npm test",\s*"git diff --quiet/,
    );
  });

  it('lists the restricted testCommands vocabulary', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('VOCABULARY');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('npm test');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('pnpm test');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('npm run typecheck');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('pnpm typecheck');
  });

  it('warns explicitly against exit-code-check acceptance criteria (anti-pattern)', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Anti-patterns');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Exit-code checks');
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain(
      'judges criteria against the diff',
    );
  });

  it('warns against runtime-claim acceptance criteria with explicit examples', () => {
    // The CHECKPOINT 3 investigation found 3/3 verifier-flagged failures
    // were "npm test passes" -shape criteria that triage spontaneously
    // emits and the verifier cannot judge from a diff. This anti-pattern
    // bullet lists those exact shapes by name.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Runtime claims');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('npm test passes');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('npm test still passes');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('tests pass');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('the build succeeds');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('no regressions are introduced');
    // The anti-pattern bullet also tells the model the constructive path:
    // restate test-related claims as observable-in-diff alternatives.
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'the diff adds a test asserting X',
    );
  });

  it('instructs the model to preserve specific behavioral verbs from task.md', () => {
    // The CHECKPOINT 3 investigation also found triage was generalizing
    // "throws RangeError" to "assertion for overflow", weakening the
    // criterion. This instruction tells triage to keep the verb verbatim.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Verb preservation');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('throws RangeError');
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain(
      'specificity is the contract',
    );
  });

  it('the acceptanceCriteria arrays in the worked examples contain NO runtime-claim entries', () => {
    // Earlier versions of Examples C and D included "npm test still passes"
    // / "npm test passes" as acceptanceCriteria entries — the exact pattern
    // the new anti-pattern section forbids. Check that no
    // acceptanceCriteria array now contains those entries.
    //
    // The Anti-patterns prose legitimately QUOTES these strings as bad
    // examples; we want to test the JSON arrays, not the surrounding text.
    const arrayBlocks = [
      ...TRIAGE_SYSTEM_PROMPT.matchAll(
        /"acceptanceCriteria":\s*\[([^\]]+)\]/g,
      ),
    ].map((m) => m[1]!);
    expect(arrayBlocks.length).toBeGreaterThanOrEqual(3); // examples A, C, D
    for (const block of arrayBlocks) {
      expect(block).not.toMatch(/"npm test (still )?passes"/);
      expect(block).not.toMatch(/"tests pass"/);
      expect(block).not.toMatch(/"all tests pass"/);
    }
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
