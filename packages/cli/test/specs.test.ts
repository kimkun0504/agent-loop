import { describe, expect, it } from 'vitest';
import { RunId } from '@agent-loop/core';
import { SPECS, SPEC_NAMES } from '@agent-loop/example-specs';
import { buildHardcodedSpec } from '@agent-loop/example-specs/hardcoded';

const NOW = '2026-05-23T15:00:00.000Z';

describe('spec registry', () => {
  it('exposes hardcoded as a known name', () => {
    expect(SPEC_NAMES).toContain('hardcoded');
  });

  it('SPECS.hardcoded resolves to the builder function', () => {
    expect(SPECS['hardcoded']).toBe(buildHardcodedSpec);
  });

  it('SPEC_NAMES is frozen — registry is not mutated at runtime', () => {
    expect(Object.isFrozen(SPEC_NAMES)).toBe(true);
  });
});

describe('buildHardcodedSpec (Candidate C: hello with optional name)', () => {
  const spec = buildHardcodedSpec(RunId('run-test'), NOW);

  it('is tied to the runId it was built for', () => {
    expect(spec.runId).toBe('run-test');
    expect(spec.id).toBe('spec-run-test');
  });

  it('uses the provided createdAt', () => {
    expect(spec.createdAt).toBe(NOW);
  });

  it('has a one-line title suitable for a PR', () => {
    expect(spec.title).toBe('Make hello() accept an optional name argument');
    expect(spec.title).not.toContain('\n');
  });

  it('description names the file to edit and all three behaviors', () => {
    expect(spec.description).toContain('src/index.js');
    expect(spec.description).toContain("returns `'hello'`");
    expect(spec.description).toContain('hello, ${name}');
    expect(spec.description).toContain('TypeError');
  });

  it('lists exactly four acceptance criteria', () => {
    expect(spec.acceptanceCriteria).toHaveLength(4);
  });

  it('acceptance criteria cover no-arg, string-arg, non-string, and tests-pass', () => {
    const all = spec.acceptanceCriteria.join('\n');
    expect(all).toContain("hello() with no arguments returns 'hello'");
    expect(all).toContain("hello('world') returns 'hello, world'");
    expect(all).toContain('hello(42) throws TypeError');
    expect(all).toContain('npm test exits 0');
  });

  it('file scope is restricted to source and tests, not config or deps', () => {
    expect(spec.fileScope).toEqual(['src/**/*.js', 'test/**/*.js']);
  });

  it('runs `npm test` as the single verification command', () => {
    expect(spec.testCommands).toEqual(['npm test']);
  });

  it('budget is tighter than DEFAULT_BUDGET (this is a small task)', () => {
    expect(spec.budget.maxTokens).toBe(200_000);
    expect(spec.budget.maxSeconds).toBe(600);
  });

  it('budget allows multiple attempts per phase (room for future retry logic)', () => {
    expect(spec.budget.maxAttemptsPerPhase).toBe(3);
  });

  it('produces different ids for different runIds', () => {
    const a = buildHardcodedSpec(RunId('run-a'), NOW);
    const b = buildHardcodedSpec(RunId('run-b'), NOW);
    expect(a.id).not.toBe(b.id);
  });
});
