// Serialization layer — the response goes through here on its way out.
// Currently just returns the object as-is. THIS is where string normalization
// (trim) should land: it's the last hop before the response leaves the system.
export const serializeResponse = (obj) => {
  // TODO: normalize string values here so the API doesn't leak user whitespace.
  return obj;
};
