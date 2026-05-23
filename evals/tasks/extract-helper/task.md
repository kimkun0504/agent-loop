`isValidUrl` is duplicated in `src/validate.js` and `src/normalize.js`. Extract it into a shared helper (your call where) and have both files use it.

Behavior must not change — the existing tests should all still pass without modification.
