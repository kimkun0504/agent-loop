const isValidUrl = (s) => {
  try { new URL(s); return true; } catch { return false; }
};

export const validate = (url) => {
  if (!isValidUrl(url)) return { ok: false, reason: 'invalid url' };
  return { ok: true };
};
