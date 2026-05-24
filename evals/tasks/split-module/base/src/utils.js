export const parseUrl = (s) => new URL(s);

export const formatUrl = (u) => `${u.protocol}//${u.host}${u.pathname}`;
