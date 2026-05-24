import { parseUrl, formatUrl } from './utils.js';

export const normalize = (s) => formatUrl(parseUrl(s));
