/**
 * Plain-text formatters for CLI output. Pure functions over domain types —
 * easy to unit test, no terminal width detection or color.
 *
 * No emoji, no boxes, no ANSI: lines should be greppable and copy-pasteable.
 */

import type { Run, Spec, Verdict, Event } from '@agent-loop/core';
import type { EventRecord } from '@agent-loop/runtime';

const COL_RUN = 24;
const COL_PHASE = 24;
const COL_UPDATED = 26;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function formatRunsTable(runs: ReadonlyArray<Run>): string {
  const header =
    pad('RUN-ID', COL_RUN) +
    pad('PHASE', COL_PHASE) +
    pad('UPDATED', COL_UPDATED) +
    'BRANCH';
  // Most recent first.
  const sorted = [...runs].sort((a, b) =>
    a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0,
  );
  const rows = sorted.map(
    (r) =>
      pad(r.id, COL_RUN) +
      pad(r.phase, COL_PHASE) +
      pad(r.updatedAt, COL_UPDATED) +
      r.branch,
  );
  return [header, ...rows].join('\n') + '\n';
}

export function formatRunDetail(run: Run): string {
  const lines: string[] = [];
  lines.push(`id          ${run.id}`);
  lines.push(`taskId      ${run.taskId}`);
  lines.push(`phase       ${run.phase}`);
  lines.push(`version     ${run.version}`);
  lines.push(`branch      ${run.branch}`);
  lines.push(`createdAt   ${run.createdAt}`);
  lines.push(`updatedAt   ${run.updatedAt}`);
  lines.push(`artifactDir ${run.artifactDir}`);
  lines.push(
    `tokens      ${run.tokensSpent}    seconds ${run.secondsSpent}    attempt ${run.attemptCount}`,
  );
  if (run.specId !== undefined) lines.push(`specId      ${run.specId}`);
  if (run.failure !== undefined) {
    lines.push(
      `failure     [${run.failure.category}] ${run.failure.message} (in ${run.failure.phase})`,
    );
  }
  if (run.abandonedReason !== undefined) {
    lines.push(`abandoned   ${run.abandonedReason}`);
  }
  return lines.join('\n') + '\n';
}

export function formatSpec(spec: Spec): string {
  const lines: string[] = [];
  lines.push('--- Spec --------------------------------------------------');
  lines.push(`id          ${spec.id}`);
  lines.push(`title       ${spec.title}`);
  lines.push('description');
  for (const l of spec.description.split('\n')) lines.push(`  ${l}`);
  lines.push(`fileScope   ${spec.fileScope.join(', ')}`);
  lines.push('acceptanceCriteria');
  for (const ac of spec.acceptanceCriteria) lines.push(`  - ${ac}`);
  lines.push(`testCommands  ${spec.testCommands.join(' && ')}`);
  lines.push(
    `budget        maxTokens=${spec.budget.maxTokens} maxSeconds=${spec.budget.maxSeconds} maxAttempts=${spec.budget.maxAttemptsPerPhase}`,
  );
  return lines.join('\n') + '\n';
}

export function formatVerdict(verdict: Verdict, index: number): string {
  const lines: string[] = [];
  const verdictNum = index + 1;
  lines.push(
    `--- Verdict #${verdictNum} (${verdict.pass ? 'PASS' : 'FAIL'}) at ${verdict.createdAt} ---`,
  );
  for (const tr of verdict.testResults) {
    lines.push(`  ${tr.command} -> exit ${tr.exitCode}, ${tr.durationMs}ms`);
  }
  lines.push(
    `  semanticCheck: matches=${verdict.semanticCheck.matches} (${verdict.semanticCheck.reasoning})`,
  );
  return lines.join('\n') + '\n';
}

export function formatEventLine(rec: EventRecord): string {
  const summary = summarizeEventPayload(rec.event);
  const tail = summary ? `  ${summary}` : '';
  return `[${rec.appliedAt}] v${rec.runVersionAfter}  ${rec.event.type}${tail}`;
}

function summarizeEventPayload(event: Event): string {
  switch (event.type) {
    case 'triage_succeeded':
      return `specId=${event.specId}`;
    case 'spec_rejected':
    case 'plan_rejected':
    case 'abandon':
      return `reason=${event.reason}`;
    case 'triage_failed':
    case 'planning_failed':
    case 'execution_failed':
    case 'verification_failed':
    case 'pr_failed':
      return `[${event.failure.category}] ${event.failure.message}`;
    case 'record_token_usage':
      return `tokens=${event.tokens}`;
    case 'record_time_spent':
      return `seconds=${event.seconds}`;
    default:
      return '';
  }
}
