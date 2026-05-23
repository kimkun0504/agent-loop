/**
 * Plain-text formatters for CLI output. Pure functions over domain types —
 * easy to unit test, no terminal width detection or color.
 *
 * No emoji, no boxes, no ANSI: lines should be greppable and copy-pasteable.
 */

import type { Run } from '@agent-loop/core';

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
