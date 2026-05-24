import { test } from 'node:test';
import assert from 'node:assert';
import { parseUrl, formatUrl } from '../src/utils.js';

test('parseUrl returns a URL', () => {
  assert.ok(parseUrl('https://example.com/x') instanceof URL);
});

test('formatUrl renders a URL back to string', () => {
  assert.strictEqual(
    formatUrl(new URL('https://example.com/x')),
    'https://example.com/x',
  );
});
