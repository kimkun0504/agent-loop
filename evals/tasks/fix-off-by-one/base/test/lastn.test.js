import { test } from 'node:test';
import assert from 'node:assert';
import { lastN } from '../src/lastn.js';

test('lastN returns the last items of an array', () => {
  // NOTE: this assertion encodes the BUGGY behavior. The right answer
  // for lastN([1,2,3,4], 2) is [3, 4]. Part of the task is fixing this test.
  assert.deepStrictEqual(lastN([1, 2, 3, 4], 2), [2, 3, 4]);
});
