const isValidUrl = (s) => {
  try { new URL(s); return true; } catch { return false; }
};

export const normalize = (url) => {
  if (!isValidUrl(url)) return null;
  return url.trim().toLowerCase();
};
