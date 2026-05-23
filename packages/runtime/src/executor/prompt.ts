/**
 * buildExecutorPrompt: turn a Spec into the natural-language prompt we hand
 * the agent. Pure function — no side effects, no I/O. Easy to test.
 *
 * The prompt is deliberately spare for week 2:
 *  - title and description
 *  - acceptance criteria (the agent's success target)
 *  - file scope (what the agent is allowed to edit)
 *  - test commands (the verifier will run these; the agent should make
 *    them pass)
 *
 * Week 3 will replace this with a planner-produced plan and a richer
 * system prompt. For now, simpler is better — fewer ways for the prompt
 * to bias the experiment.
 */

import type { Spec } from '@agent-loop/core';

export function buildExecutorPrompt(spec: Spec): string {
  const lines: string[] = [];
  lines.push(`# Task: ${spec.title}`);
  lines.push('');
  lines.push(spec.description.trim());
  lines.push('');

  if (spec.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria');
    for (const ac of spec.acceptanceCriteria) {
      lines.push(`- ${ac}`);
    }
    lines.push('');
  }

  if (spec.fileScope.length > 0) {
    lines.push('## Allowed file scope');
    lines.push('You may create, modify, or delete files matching:');
    for (const glob of spec.fileScope) {
      lines.push(`- ${glob}`);
    }
    lines.push('');
  }

  if (spec.testCommands.length > 0) {
    lines.push('## How your work will be verified');
    lines.push('These commands will run after you finish. They must all pass:');
    for (const cmd of spec.testCommands) {
      lines.push(`- \`${cmd}\``);
    }
    lines.push('');
  }

  lines.push(
    'Work in the current directory. When you believe the acceptance ' +
      'criteria are met, exit cleanly.',
  );

  return lines.join('\n');
}
