/**
 * Tests for the calibration disagreement sections in report.md.
 *
 * report.ts has no exported formatter — it writes to disk. We exercise
 * the section via writeResults() into a tmpdir and read back report.md.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeResults } from '../../src/eval/report.js';
import type { EvalTaskResult } from '../../src/eval/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-loop-report-'));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

function task(
  name: string,
  passed: boolean,
  anchor?: EvalTaskResult['calibrationAnchor'],
  semanticReasoning?: string,
): EvalTaskResult {
  const result: EvalTaskResult = {
    name,
    passed,
    phase: passed ? 'done' : 'failed',
    runId: `run-${name}`,
    durationMs: 1000,
    tokensSpent: 1000,
    costUsd: 0.1,
    cacheHitRate: 0.9,
    perPhase: {},
    failure: null,
  };
  if (anchor !== undefined) result.calibrationAnchor = anchor;
  if (semanticReasoning !== undefined) result.semanticReasoning = semanticReasoning;
  return result;
}

describe('formatReportMd: calibration section', () => {
  it('omits the section entirely when no task has a calibrationAnchor', async () => {
    await writeResults(dir, [task('a', true), task('b', true)]);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).not.toContain('Calibration disagreements');
    expect(md).not.toContain('Calibration coverage');
  });

  it('shows 0/M agreement when all anchored tasks agree', async () => {
    const anchor = {
      commands: ['echo ok'], exitCodes: [0], anchorPass: true, agreement: true,
    };
    await writeResults(dir, [
      task('a', true, anchor),
      task('b', true, anchor),
    ]);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('## Calibration disagreements');
    expect(md).toContain('0/2 tasks disagreed');
    expect(md).toContain('full agreement');
    expect(md).toContain('## Calibration coverage');
    expect(md).toContain('2/2 tasks');
  });

  it('lists each disagreement with anchor commands + exit codes + Investigate line', async () => {
    const agreeing = {
      commands: ['echo ok'], exitCodes: [0], anchorPass: true, agreement: true,
    };
    const falsePositiveAnchor = {
      commands: ["! grep -r foo src/", "test -f src/x.js"],
      exitCodes: [1, 0],
      anchorPass: false,
      agreement: false,
    };
    await writeResults(dir, [
      task('alpha', true, agreeing),
      task('bravo', true, falsePositiveAnchor, '5/5 acceptance criteria met'),
    ]);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('1/2 tasks disagreed');
    expect(md).toContain('`bravo`');
    expect(md).toContain('anchor=fail, semantic=pass');
    expect(md).toContain('potential false positive');
    expect(md).toContain('`! grep -r foo src/`');
    expect(md).toContain('exit 1');
    expect(md).toContain('Investigate:');
    expect(md).toContain('verdict-001.json');
    expect(md).toContain('5/5 acceptance criteria met');
  });

  it('labels anchor=pass, semantic=fail disagreement direction', async () => {
    const anchor = {
      commands: ['echo ok'],
      exitCodes: [0],
      anchorPass: true,
      agreement: false,
    };
    await writeResults(dir, [
      task('semantic-fail', false, anchor, 'criterion 2 not met'),
    ]);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('anchor=pass, semantic=fail');
    expect(md).not.toContain('potential false positive');
  });

  it('coverage section notes when not all tasks have anchors', async () => {
    const anchor = {
      commands: ['echo ok'], exitCodes: [0], anchorPass: true, agreement: true,
    };
    await writeResults(dir, [
      task('a', true, anchor),
      task('b', true), // no anchor — calibration mode off / no commands
      task('c', true, anchor),
    ]);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('2/3 tasks produced an anchor verdict');
    expect(md).toContain('Tasks excluded from the calibration disagreement count');
    expect(md).toContain('gap-calibration-anchor-removal');
  });
});
