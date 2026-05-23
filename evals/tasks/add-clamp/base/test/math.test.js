import { test } from 'node:test';
import assert from 'node:assert';
import { multiply } from '../src/math.js';

test('multiply', () => {
  assert.strictEqual(multiply(2, 3), 6);
});
