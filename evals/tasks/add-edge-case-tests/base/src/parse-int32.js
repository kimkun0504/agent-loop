const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export const parseInt32 = (str) => {
  if (typeof str !== 'string') throw new TypeError('parseInt32 expects a string');
  const trimmed = str.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new RangeError(`not an integer: ${str}`);
  const n = Number(trimmed);
  if (n < INT32_MIN || n > INT32_MAX) throw new RangeError(`out of int32 range: ${str}`);
  return n;
};
