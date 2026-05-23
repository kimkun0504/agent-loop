import { parseDate } from './date.js';

export const formatYear = (s) => {
  const d = parseDate(s);
  return String(d.getUTCFullYear());
};
