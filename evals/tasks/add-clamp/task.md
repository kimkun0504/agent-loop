Add a `clamp(value, min, max)` helper to `src/math.js`. It should pin value into the `[min, max]` range — return `min` when value is below, `max` when above, value otherwise.

The existing test file `test/math.test.js` tests `multiply`. Add a new test file `test/clamp.test.js` (or add tests to the existing file — your choice) for the new function. Make sure the existing multiply test still passes.
