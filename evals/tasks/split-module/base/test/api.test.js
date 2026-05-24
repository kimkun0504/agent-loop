import { test } from 'node:test';
import assert from 'node:assert';
import { normalize } from '../src/api.js';

test('normalize round-trips a URL through parse + format', () => {
  assert.strictEqual(
    normalize('https://example.com/x'),
    'https://example.com/x',
  );
});
