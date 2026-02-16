function addFileToBucket(bucketMap, key, filePath) {
  const normalizedKey = String(key || '').trim();
  const normalizedFilePath = String(filePath || '').trim();
  if (!normalizedKey || !normalizedFilePath) return;

  let bucket = bucketMap.get(normalizedKey);
  if (!bucket) {
    bucket = new Set();
    bucketMap.set(normalizedKey, bucket);
  }
  bucket.add(normalizedFilePath);
}

function unionBuckets(bucketMap, keys = []) {
  const merged = new Set();
  for (const key of keys) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    const bucket = bucketMap.get(normalizedKey);
    if (!bucket) continue;
    for (const item of bucket) {
      merged.add(item);
    }
  }
  return merged;
}

function intersectSets(sets = []) {
  if (!Array.isArray(sets) || sets.length === 0) return new Set();
  const sorted = sets.slice().sort((left, right) => left.size - right.size);
  const [seed, ...rest] = sorted;
  const result = new Set(seed);
  for (const set of rest) {
    for (const value of result) {
      if (!set.has(value)) {
        result.delete(value);
      }
    }
  }
  return result;
}

function createMemoryArchiveIndex() {
  const bySessionId = new Map();
  const byTabId = new Map();
  const byEventType = new Map();
  const byDayStamp = new Map();
  const loadedDays = new Set();

  function addRecord(record, filePath) {
    const data = record && typeof record === 'object' ? record : {};
    const resolvedFilePath = String(filePath || '').trim();
    if (!resolvedFilePath) return;

    addFileToBucket(bySessionId, data.sessionId, resolvedFilePath);
    addFileToBucket(byTabId, data.tabId, resolvedFilePath);
    addFileToBucket(byEventType, data.eventType, resolvedFilePath);
    addFileToBucket(byDayStamp, String(data.ts || '').slice(0, 10), resolvedFilePath);
  }

  function markDayLoaded(dayStamp) {
    const normalized = String(dayStamp || '').trim();
    if (normalized) loadedDays.add(normalized);
  }

  function areDaysLoaded(dayStamps = []) {
    const normalized = dayStamps
      .map((day) => String(day || '').trim())
      .filter(Boolean);
    if (normalized.length === 0) return false;
    return normalized.every((day) => loadedDays.has(day));
  }

  function getCandidateFiles(filters = {}) {
    const sets = [];
    const sessionId = String(filters.sessionId || '').trim();
    const tabId = String(filters.tabId || '').trim();
    const eventType = String(filters.eventType || '').trim();
    const dayStamps = Array.isArray(filters.dayStamps) ? filters.dayStamps : [];

    if (sessionId) {
      const bucket = bySessionId.get(sessionId);
      if (bucket && bucket.size > 0) sets.push(bucket);
    }

    if (tabId) {
      const bucket = byTabId.get(tabId);
      if (bucket && bucket.size > 0) sets.push(bucket);
    }

    if (eventType) {
      const bucket = byEventType.get(eventType);
      if (bucket && bucket.size > 0) sets.push(bucket);
    }

    if (dayStamps.length > 0) {
      const unionDaySet = unionBuckets(byDayStamp, dayStamps);
      if (unionDaySet.size > 0) sets.push(unionDaySet);
    }

    if (sets.length === 0) return [];
    return Array.from(intersectSets(sets));
  }

  return {
    addRecord,
    markDayLoaded,
    areDaysLoaded,
    getCandidateFiles
  };
}

module.exports = {
  createMemoryArchiveIndex
};
