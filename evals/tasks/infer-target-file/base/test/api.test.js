import { test } from 'node:test';
import assert from 'node:assert';
import { handleGetUser } from '../src/api.js';

test('trims string fields in the response', () => {
  const result = handleGetUser({
    id: 1,
    name: '  Alice  ',
    email: ' alice@example.com\n',
    age: 30,
    active: true,
    preferences: { theme: '  dark  ' }, // nested — should NOT be recursively trimmed
  });
  assert.strictEqual(result.name, 'Alice');
  assert.strictEqual(result.email, 'alice@example.com');
});

test('passes non-string values through unchanged', () => {
  const result = handleGetUser({
    id: 42,
    name: 'Bob',
    email: 'bob@example.com',
    age: 25,
    active: false,
    preferences: null,
  });
  assert.strictEqual(result.id, 42);
  assert.strictEqual(result.age, 25);
  assert.strictEqual(result.active, false);
  assert.strictEqual(result.preferences, null);
});

test('does NOT recursively trim nested objects (shallow only)', () => {
  const result = handleGetUser({
    id: 1,
    name: 'x',
    email: 'x@x.com',
    age: 1,
    active: true,
    preferences: { theme: '  dark  ' }, // inner whitespace must remain
  });
  assert.strictEqual(result.preferences.theme, '  dark  ');
});
