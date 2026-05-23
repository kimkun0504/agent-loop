/**
 * Write eval results to disk: summary.json (machine-readable, source of
 * truth) and report.md (human-readable rollup).
 *
 * summary.json is the canonical file. report.md is a derivative — never
 * read by tooling, only by humans.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execa } from 'execa';
import { join } from 'node:path';
import { aggregateResults } from './metrics.js';
import type { EvalSummary, EvalTaskResult } from './types.js';

const SUMMARY_SCHEMA_VERSION = 1;

export async function writeResults(
  resultsDir: string,
  results: ReadonlyArray<EvalTaskResult>,
): Promise<EvalSummary> {
  mkdirSync(resultsDir, { recursive: true });

  const summary: EvalSummary = {
    timestamp: new Date().toISOString(),
    gitHead: await captureGitHead(),
    totalTasks: results.length,
    passed: results.filter((r) => r.passed).length,
    passRate:
      results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length,
    perTask: [...results],
    aggregates: aggregateResults(results),
  };

  // schemaVersion is added under the same _schemaVersion key used by other
  // artifacts in the project (executor.json, meta.json, etc.). Keeping the
  // top-level type matches the EvalSummary contract; the version lives
  // alongside as a sibling field on disk.
  const onDisk = { schemaVersion: SUMMARY_SCHEMA_VERSION, ...summary };
  writeFileSync(
    join(resultsDir, 'summary.json'),
    JSON.stringify(onDisk, null, 2) + '\n',
  );
  writeFileSync(join(resultsDir, 'report.md'), formatReportMd(summary));
  return summary;
}

async function captureGitHead(): Promise<string> {
  try {
    const r = await execa('git', ['rev-parse', '--short=10', 'HEAD']);
    return r.stdout.trim();
  } catch {
    return 'unknown';
  }
}

function formatReportMd(s: EvalSummary): string {
  const lines: string[] = [];
  lines.push(`# Eval results — ${s.timestamp}`);
  lines.push('');
  lines.push(`Git HEAD: \`${s.gitHead}\``);
  lines.push('');
  lines.push(`**Pass rate: ${s.passed} / ${s.totalTasks} (${(s.passRate * 100).toFixed(1)}%)**`);
  lines.push('');
  lines.push('## Per-task');
  lines.push('');
  lines.push('| Task | Result | Phase | Duration | Tokens | Cost (USD) | Cache hit |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of s.perTask) {
    const result = r.passed ? 'PASS' : 'FAIL';
    const dur = (r.durationMs / 1000).toFixed(1) + 's';
    const cost = `$${r.costUsd.toFixed(4)}`;
    const cache = `${(r.cacheHitRate * 100).toFixed(0)}%`;
    lines.push(
      `| \`${r.name}\` | ${result} | ${r.phase} | ${dur} | ${r.tokensSpent} | ${cost} | ${cache} |`,
    );
  }
  lines.push('');
  lines.push('## Aggregates');
  lines.push('');
  lines.push(`- p50 duration: ${(s.aggregates.p50DurationMs / 1000).toFixed(1)}s`);
  lines.push(`- p95 duration: ${(s.aggregates.p95DurationMs / 1000).toFixed(1)}s`);
  lines.push(`- median cost: $${s.aggregates.medianCostUsd.toFixed(4)}`);
  lines.push(`- p95 cost: $${s.aggregates.p95CostUsd.toFixed(4)}`);
  lines.push(`- p50 cache hit rate: ${(s.aggregates.p50CacheHitRate * 100).toFixed(0)}%`);
  lines.push('');
  return lines.join('\n');
}
