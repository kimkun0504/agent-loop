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
import { formatPerPhaseCost, instrument } from './instrumentation.js';
import type { EvalSummary, EvalTaskResult } from './types.js';

const SUMMARY_SCHEMA_VERSION = 1;

export async function writeResults(
  resultsDir: string,
  results: ReadonlyArray<EvalTaskResult>,
): Promise<EvalSummary> {
  mkdirSync(resultsDir, { recursive: true });

  const instrumentation = instrument(resultsDir, results);

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
  // Only populate when there's planner output to talk about — keeps
  // baseline-mode summaries free of zero-padded planner fields.
  if (instrumentation.plannerSignals.withPlannerOutput > 0) {
    summary.plannerSignals = instrumentation.plannerSignals;
  }
  if (instrumentation.planQualityMismatches.length > 0) {
    summary.planQualityMismatches = instrumentation.planQualityMismatches;
  }

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

  // CHECKPOINT 3 sections (only when planner ran).
  if (s.plannerSignals) {
    lines.push('## Planner signals (CHECKPOINT 3)');
    lines.push('');
    lines.push(
      `**Context-seeking rate: ${(s.plannerSignals.contextSeekingRate * 100).toFixed(0)}%** (${s.plannerSignals.contextSeekingCount} of ${s.plannerSignals.withPlannerOutput} planner outputs contained "need to see", "depends on", or similar phrasing — re-prioritization signal for gap-triage-thin-context).`,
    );
    lines.push('');
    if (s.plannerSignals.perTask.length > 0) {
      lines.push('| Task | Context-seeking? | Matched phrases |');
      lines.push('|---|---|---|');
      for (const t of s.plannerSignals.perTask) {
        const flag = t.contextSeeking ? 'yes' : 'no';
        const phrases = t.matchedPhrases.length > 0 ? t.matchedPhrases.join(', ') : '—';
        lines.push(`| \`${t.name}\` | ${flag} | ${phrases} |`);
      }
      lines.push('');
    }
  }

  if (s.planQualityMismatches && s.planQualityMismatches.length > 0) {
    lines.push('## Plan-quality mismatches');
    lines.push('');
    lines.push(
      `Runs where the planner produced a plan but the run failed downstream. These are the most interesting failures to inspect — good spec, plan written, executor or verifier rejected.`,
    );
    lines.push('');
    for (const m of s.planQualityMismatches) {
      lines.push(`- \`${m.name}\`: failed at ${m.failedPhase} with [${m.failureCategory}]`);
    }
    lines.push('');
  }

  // Per-phase cost breakdown for the first passing task (when one exists).
  const sampleTask = s.perTask.find((t) => t.passed);
  if (sampleTask) {
    lines.push('## Sample per-phase cost (one passing task)');
    lines.push('');
    lines.push(formatPerPhaseCost(sampleTask));
    lines.push('');
  }

  appendCalibrationSection(lines, s);

  return lines.join('\n');
}

/**
 * Calibration disagreements + coverage section. Emitted only when at
 * least one task ran with calibration mode enabled (= at least one
 * EvalTaskResult has a calibrationAnchor field). Denominator M is the
 * count of tasks where the anchor produced a verdict — runs where the
 * anchor never ran (calibration mode off, or no calibrationTestCommands)
 * are excluded, preventing structural disagreements from polluting the
 * agreement rate. See docs/triage-verifier-refactor.md §"Eval report format".
 */
function appendCalibrationSection(lines: string[], s: EvalSummary): void {
  const withAnchor = s.perTask.filter((t) => t.calibrationAnchor !== undefined);
  if (withAnchor.length === 0) return;

  const disagreements = withAnchor.filter(
    (t) => t.calibrationAnchor?.agreement === false,
  );

  lines.push('## Calibration disagreements');
  lines.push('');
  if (disagreements.length === 0) {
    lines.push(
      `0/${withAnchor.length} tasks disagreed (anchor and semantic verifier in full agreement).`,
    );
    lines.push('');
  } else {
    lines.push(`${disagreements.length}/${withAnchor.length} tasks disagreed.`);
    lines.push('');
    for (const t of disagreements) {
      const a = t.calibrationAnchor!;
      const direction = a.anchorPass
        ? 'anchor=pass, semantic=fail'
        : 'anchor=fail, semantic=pass (potential false positive)';
      lines.push(`- \`${t.name}\`: ${direction}`);
      lines.push('  Anchor commands:');
      for (let i = 0; i < a.commands.length; i++) {
        lines.push(`    - \`${a.commands[i]}\` → exit ${a.exitCodes[i] ?? '?'}`);
      }
      if (t.semanticReasoning) {
        lines.push(`  Semantic verdict reasoning: ${t.semanticReasoning}`);
      }
      lines.push(
        `  Investigate: open verdict-001.json + executor.log under the run's artifact dir (run \`${t.runId}\`). If the semantic verifier's reasoning cites diff evidence that contradicts what the anchor's exit code reports, the anchor is over-strict (false fail) — likely whitespace/encoding noise. If the reasoning is correct and matches what the anchor would report, the verifier is over-permissive (rubber-stamp) or under-strict (over-permissive).`,
      );
    }
    lines.push('');
  }

  lines.push('## Calibration coverage');
  lines.push('');
  lines.push(`${withAnchor.length}/${s.totalTasks} tasks produced an anchor verdict.`);
  if (withAnchor.length < s.totalTasks) {
    lines.push('');
    lines.push(
      `Tasks excluded from the calibration disagreement count: those whose \`expected.json\` has no \`calibrationTestCommands\` field (anchor inactive). Adding the anchor to all tasks would tighten the calibration signal — but a 0/${withAnchor.length} rate on the tasks WITH an anchor is what gates \`gap-calibration-anchor-removal\`.`,
    );
  }
  lines.push('');
}
