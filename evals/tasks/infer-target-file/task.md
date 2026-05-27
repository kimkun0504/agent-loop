API responses are coming back with extra whitespace in string fields — leading or trailing spaces in user-supplied data. Please normalize string values in the response so they're trimmed before they leave us.

**Important: trim only top-level string values.** Numbers, booleans, nulls, AND nested objects/arrays must pass through unchanged. The API contract requires that nested data structures are returned verbatim — they're consumed by downstream services that depend on byte-for-byte preservation. Do NOT recurse into nested values.

The existing test in `test/api.test.js` documents this constraint — specifically the test named "does NOT recursively trim nested objects (shallow only)".
