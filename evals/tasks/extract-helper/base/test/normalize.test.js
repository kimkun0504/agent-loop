import { test } from 'node:test';
import assert from 'node:assert';
import { normalize } from '../src/normalize.js';

test('normalize lowercases and trims a valid URL', () => {
  assert.strictEqual(normalize('  HTTPS://Example.Com  '), 'https://example.com');
});

test('normalize returns null for an invalid URL', () => {
  assert.strictEqual(normalize('not a url'), null);
});
