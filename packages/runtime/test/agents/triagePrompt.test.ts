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

  it('contains all five worked examples', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example A');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example B');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example C');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example D');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Example E');
    // B is the vague-task → rejection example.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Improve the performance');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('too_vague');
    // C is the rename, expressed via natural-language absence claim.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Rename oldName to newName');
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'no occurrence of the token oldName',
    );
    // D is the test-only change, now using fileStateChecks for the
    // "unchanged" assertion (Option E).
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Add edge-case tests for isValidEmail');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"fileStateChecks"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"type": "unchanged"');
    // E is the new content-preservation example using diff-observable
    // negative claims.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Add clamp helper to src/math.js');
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'no hunk in the diff deletes the multiply test',
    );
  });

  it('describes fileStateChecks as a structured field with 4 enum types', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('fileStateChecks');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"unchanged"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"deleted"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"exists"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"absent"');
    // Each type's shell translation is documented in the field guidance.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('git diff --quiet main');
  });

  it('warns against content claims about files outside the diff (Option E anti-pattern)', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'Content claims about files outside the diff',
    );
    // The specific failing-criterion shape from CHECKPOINT 3 rounds is
    // called out by name.
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'test/math.test.js still contains the multiply test',
    );
    // The constructive paths: use fileStateChecks for unchanged-status,
    // or express stronger claims as diff-observable negative claims.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Use `fileStateChecks`');
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain(
      'diff-observable negative claim',
    );
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'no hunk in the diff deletes',
    );
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

  it('warns against COMPOUND runtime-claim criteria (X exists AND Y still passes)', () => {
    // CHECKPOINT 3 second-round investigation found triage emitting
    // compound shapes like "test/math.test.js contains a test for X
    // and it still passes" — the simple-form anti-pattern (commit
    // 831dfe6) didn't catch these. This bullet extends coverage to
    // compound forms.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Compound runtime claims');
    // Conjunctions listed by name so the model recognizes the pattern.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"and"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"also"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"plus"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"while"');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"moreover"');
    // Specific failing shapes from the CHECKPOINT 3 runs called out.
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'contains a test for X and it still passes',
    );
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'remains unchanged and continues to pass',
    );
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'exports parseQuux and the new tests pass',
    );
    // The constructive path: split into single-form criteria.
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('split them');
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'remains unchanged from the initial commit',
    );
  });

  it('the worked examples contain NO compound runtime claims (and X passes / also Y)', () => {
    const arrayBlocks = [
      ...TRIAGE_SYSTEM_PROMPT.matchAll(
        /"acceptanceCriteria":\s*\[([^\]]+)\]/g,
      ),
    ].map((m) => m[1]!);
    expect(arrayBlocks.length).toBeGreaterThanOrEqual(3);
    // The detection regex used by the eval meta-test:
    const compoundRuntimeClaim =
      /\b(and|also|plus|while|moreover)\s+.{0,60}\b(pass(es)?|build succeeds|works correctly|run correctly|no regressions)/i;
    for (const block of arrayBlocks) {
      // Split entries by line so we test each criterion individually
      // (a block may contain a benign "and" between criteria).
      const entries = block.match(/"[^"]+"/g) ?? [];
      for (const entry of entries) {
        expect(entry).not.toMatch(compoundRuntimeClaim);
      }
    }
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

  it('warns against drifting from constraints stated in task.md (Constraint preservation)', () => {
    // CHECKPOINT 3 Option E validation round (2026-05-26) found triage
    // emitting "Nested objects are recursively processed" for
    // infer-target-file despite task.md explicitly saying nested objects
    // pass through unchanged. The architecture caught the contradiction;
    // this section addresses the drift at cause.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Constraint preservation');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('passes through unchanged');
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain(
      'do not broaden the task',
    );
    // Trigger-phrase list so the model can self-apply the rule by
    // scanning for these tokens in task.md.
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('do not');
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('must not');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('references to existing tests');
    // The example pair from the infer-target-file family is called out
    // verbatim so the model sees both shapes.
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'recursively processes nested objects',
    );
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      'returned unchanged (not recursively processed)',
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
