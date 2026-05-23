`lastN` is returning one too many items when n>0 — it should return exactly n items. The test currently expects the wrong behavior; fix both the function and the test.

Also handle the edge cases: `n=0` returns `[]`, `n>arr.length` returns the whole array. Note: in JavaScript, `arr.slice(-n)` does NOT do the right thing when `n=0` (it returns the whole array, because `-0 === 0` and `slice(0)` is everything) — handle that case explicitly.
