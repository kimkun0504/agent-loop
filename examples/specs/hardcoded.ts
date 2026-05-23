/**
 * Hardcoded spec for the week 2 thin-slice demo.
 *
 * Target repo: agent-loop-target (one-function, one-test ESM project).
 *
 * Task: make `hello()` accept an optional `name` argument.
 *  - hello()         -> 'hello'          (unchanged)
 *  - hello('world')  -> 'hello, world'   (new)
 *  - hello(42)       -> throws TypeError (new)
 *
 * This is "Candidate C" from the plan — small, but it forces the agent to
 * *integrate* with existing code rather than just append.
 *
 * Pure factory (no I/O); takes a fresh runId and now() so each invocation
 * produces a Spec tied to the right run.
 */

import { type Spec, type RunId, SpecId } from '@agent-loop/core';

export function buildHardcodedSpec(runId: RunId, now: string): Spec {
  return {
    id: SpecId(`spec-${runId}`),
    runId,
    title: 'Make hello() accept an optional name argument',
    description: [
      'The `hello` function in `src/index.js` currently returns the string',
      "`'hello'` regardless of input. Extend it to accept an optional `name`",
      'parameter with these semantics:',
      '',
      "- Called with no arguments: returns `'hello'` (unchanged).",
      '- Called with a string `name`: returns `` `hello, ${name}` ``.',
      '- Called with any non-string value (number, object, null, undefined',
      '  explicitly, etc.): throws a `TypeError`.',
      '',
      'Update existing tests and add new tests in `test/` to cover all three',
      'cases. The original assertion (`hello()` returns `\'hello\'`) must',
      'continue to pass.',
    ].join('\n'),
    fileScope: ['src/**/*.js', 'test/**/*.js'],
    acceptanceCriteria: [
      "hello() with no arguments returns 'hello'",
      "hello('world') returns 'hello, world'",
      'hello(42) throws TypeError',
      'npm test exits 0',
    ],
    testCommands: ['npm test'],
    budget: {
      // Tighter than DEFAULT_BUDGET for a small task. Week 2 doesn't retry
      // phases, but maxAttemptsPerPhase=3 leaves room for the verifier to
      // tolerate a flake on one of multiple commands and for future retry
      // logic to land without revising the spec.
      maxTokens: 200_000,
      maxSeconds: 600,
      maxAttemptsPerPhase: 3,
    },
    createdAt: now,
  };
}
