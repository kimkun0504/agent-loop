import { test } from 'node:test';
import assert from 'node:assert';
import { validate } from '../src/validate.js';

test('validate accepts a valid URL', () => {
  assert.deepStrictEqual(validate('https://example.com'), { ok: true });
});

test('validate rejects garbage', () => {
  assert.strictEqual(validate('not a url').ok, false);
});
