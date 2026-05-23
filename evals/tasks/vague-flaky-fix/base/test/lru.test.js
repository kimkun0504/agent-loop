import { test } from 'node:test';
import assert from 'node:assert';
import { lruCache } from '../src/lru.js';

test('evicts the least-recently-used item on overflow', () => {
  const c = lruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  // 'a' is least-recently-used at this point. Adding 'c' should evict 'a'.
  c.set('c', 3);
  assert.strictEqual(c.get('a'), undefined, 'a should have been evicted');
  assert.strictEqual(c.get('b'), 2, 'b should remain');
  assert.strictEqual(c.get('c'), 3, 'c should remain');
});

test('get() promotes the entry to most-recently-used', () => {
  const c = lruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  // Touch 'a' so it becomes most-recently-used; 'b' is now LRU.
  c.get('a');
  c.set('c', 3);
  assert.strictEqual(c.get('a'), 1, "a should remain (touched, so it's not LRU)");
  assert.strictEqual(c.get('b'), undefined, 'b should have been evicted');
});
