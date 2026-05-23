// A small LRU cache. BUG: when capacity is exceeded the wrong entry is evicted —
// the most-recently-inserted one rather than the least-recently-used. Also, get()
// returns the value without promoting the entry to most-recently-used.
export const lruCache = (capacity) => {
  const map = new Map();
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      if (map.size >= capacity && !map.has(key)) {
        // BUG: should evict the OLDEST (first inserted / least-recently-used);
        // instead this evicts the newest just-inserted entry on next set.
        const lastKey = [...map.keys()].pop();
        map.delete(lastKey);
      }
      map.set(key, value);
    },
    size() { return map.size; },
  };
};
