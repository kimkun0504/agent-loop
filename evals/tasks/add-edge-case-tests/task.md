Our `parseInt32` implementation looks correct but test coverage is thin. Add tests for: negative numbers, leading/trailing whitespace, values at INT32 boundaries (`-2^31`, `2^31-1`), values that overflow Int32, and non-numeric input.

Don't modify `src/parse-int32.js` — just add tests.
