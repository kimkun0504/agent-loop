import { test } from 'node:test';
import assert from 'node:assert';
import { formatYear } from '../src/format.js';
import { parseDate } from '../src/date.js';

test('formatYear returns the year as a string', () => {
  assert.strictEqual(formatYear('2026-05-23'), '2026');
});

test('parseDate returns a Date for valid ISO input', () => {
  // Touches parseDate directly so the rename has to update test code too.
  assert.ok(parseDate('2026-01-01') instanceof Date);
});
