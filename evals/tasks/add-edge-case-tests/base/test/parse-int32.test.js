import { test } from 'node:test';
import assert from 'node:assert';
import { parseInt32 } from '../src/parse-int32.js';

test('parseInt32 parses a basic positive integer', () => {
  assert.strictEqual(parseInt32('42'), 42);
});
