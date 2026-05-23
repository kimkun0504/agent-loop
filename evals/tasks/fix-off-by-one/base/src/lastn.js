// Returns the last n items of arr.
// BUG: returns n+1 items because the offset is off by one.
export const lastN = (arr, n) => arr.slice(-n - 1);
