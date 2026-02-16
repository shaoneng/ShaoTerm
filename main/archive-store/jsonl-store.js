const fs = require('fs');
const path = require('path');

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeLine(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeQueryMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'legacy' ? 'legacy' : 'auto';
}

function readJsonLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return [];
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

function isDayStamp(name) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function collectDayDirectories(archiveRootDir, days) {
  if (!archiveRootDir || !fs.existsSync(archiveRootDir)) return [];
  const now = Date.now();
  const maxAgeMs = days * 24 * 60 * 60 * 1000;

  return fs.readdirSync(archiveRootDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && isDayStamp(item.name))
    .map((item) => item.name)
    .filter((stamp) => {
      const ts = new Date(`${stamp}T00:00:00Z`).getTime();
      return Number.isFinite(ts) && now - ts <= maxAgeMs;
    })
    .sort((left, right) => right.localeCompare(left));
}

function listArchiveFilesByDays(archiveRootDir, dayStamps = []) {
  const files = [];
  for (const day of dayStamps) {
    const dirPath = path.join(archiveRootDir, day);
    if (!fs.existsSync(dirPath)) continue;
    const dayFiles = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((item) => item.isFile() && item.name.endsWith('.jsonl'))
      .map((item) => path.join(dirPath, item.name));
    files.push(...dayFiles);
  }
  return files;
}

function createArchiveStoreMetadataCache() {
  return {
    mtimeMs: -1,
    state: {
      version: 1,
      updatedAt: '',
      sessions: {}
    }
  };
}

function createJsonlStore(options = {}) {
  const getArchiveRootDir = typeof options.getArchiveRootDir === 'function'
    ? options.getArchiveRootDir
    : () => String(options.archiveRootDir || '').trim();
  const resolveSessionIdByTab = typeof options.resolveSessionIdByTab === 'function'
    ? options.resolveSessionIdByTab
    : () => '';
  const index = options.index || null;
  const maxQueryDays = clampInteger(options.maxQueryDays, 1, 365, 90);
  const defaultQueryDays = clampInteger(options.defaultQueryDays, 1, maxQueryDays, 14);
  const maxQueryLimit = clampInteger(options.maxQueryLimit, 1, 5000, 200);
  const defaultQueryLimit = clampInteger(options.defaultQueryLimit, 1, maxQueryLimit, 40);
  const metadataCache = createArchiveStoreMetadataCache();

  function getArchiveIndexPath() {
    const archiveRootDir = getArchiveRootDir();
    return archiveRootDir ? path.join(archiveRootDir, 'index.json') : '';
  }

  function createEmptyArchiveIndexState() {
    return {
      version: 1,
      updatedAt: '',
      sessions: {}
    };
  }

  function ensureDirSync(dirPath) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return true;
    } catch (err) {
      return false;
    }
  }

  function readArchiveIndexState() {
    const indexPath = getArchiveIndexPath();
    if (!indexPath || !fs.existsSync(indexPath)) {
      metadataCache.mtimeMs = -1;
      metadataCache.state = createEmptyArchiveIndexState();
      return metadataCache.state;
    }

    let stat;
    try {
      stat = fs.statSync(indexPath);
    } catch (err) {
      metadataCache.mtimeMs = -1;
      metadataCache.state = createEmptyArchiveIndexState();
      return metadataCache.state;
    }

    if (stat.mtimeMs === metadataCache.mtimeMs) {
      return metadataCache.state;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const sessions = parsed && parsed.sessions && typeof parsed.sessions === 'object'
        ? parsed.sessions
        : {};
      metadataCache.state = {
        version: parsed && Number.isInteger(parsed.version) ? parsed.version : 1,
        updatedAt: parsed && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        sessions
      };
      metadataCache.mtimeMs = stat.mtimeMs;
    } catch (err) {
      metadataCache.state = createEmptyArchiveIndexState();
      metadataCache.mtimeMs = stat.mtimeMs;
    }
    return metadataCache.state;
  }

  function writeArchiveIndexState(nextState) {
    const archiveRootDir = getArchiveRootDir();
    if (!archiveRootDir) return false;
    if (!ensureDirSync(archiveRootDir)) return false;

    const indexPath = getArchiveIndexPath();
    if (!indexPath) return false;

    try {
      fs.writeFileSync(indexPath, JSON.stringify(nextState, null, 2), 'utf8');
      metadataCache.state = nextState;
      try {
        const stat = fs.statSync(indexPath);
        metadataCache.mtimeMs = stat.mtimeMs;
      } catch (err) {
        metadataCache.mtimeMs = Date.now();
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function resolveArchiveFileBySessionId(sessionId) {
    const archiveRootDir = getArchiveRootDir();
    if (!archiveRootDir || !sessionId) return '';

    const sessions = readArchiveIndexState().sessions || {};
    const sessionMeta = sessions[sessionId];
    if (!sessionMeta || !sessionMeta.archivePath) return '';

    const filePath = path.join(archiveRootDir, sessionMeta.archivePath);
    if (!fs.existsSync(filePath)) return '';
    return filePath;
  }

  function hydrateIndexForDays(archiveRootDir, dayStamps) {
    if (!index || dayStamps.length === 0) return;
    if (typeof index.areDaysLoaded === 'function' && index.areDaysLoaded(dayStamps)) return;

    for (const day of dayStamps) {
      if (typeof index.areDaysLoaded === 'function' && index.areDaysLoaded([day])) continue;
      const files = listArchiveFilesByDays(archiveRootDir, [day]);
      for (const filePath of files) {
        const records = readJsonLines(filePath);
        for (const record of records) {
          if (typeof index.addRecord === 'function') {
            index.addRecord(record, filePath);
          }
        }
      }
      if (typeof index.markDayLoaded === 'function') {
        index.markDayLoaded(day);
      }
    }
  }

  function normalizeQueryOptions(options = {}) {
    const days = clampInteger(options.days, 1, maxQueryDays, defaultQueryDays);
    const limit = clampInteger(options.limit, 1, maxQueryLimit, defaultQueryLimit);
    const keyword = sanitizeLine(options.keyword, 120).toLowerCase();
    const eventType = sanitizeLine(options.eventType, 40);
    const tabId = sanitizeLine(options.tabId, 80);
    const cwd = sanitizeLine(options.cwd, 280);
    const queryMode = normalizeQueryMode(options.queryMode);
    let sessionId = sanitizeLine(options.sessionId, 120);
    if (!sessionId && tabId) {
      sessionId = sanitizeLine(resolveSessionIdByTab(tabId), 120);
    }
    return {
      days,
      limit,
      keyword,
      eventType,
      tabId,
      cwd,
      sessionId,
      queryMode
    };
  }

  function collectFilesForQuery(archiveRootDir, queryOptions) {
    const files = [];
    let usedIndex = false;

    if (queryOptions.sessionId) {
      const targetFile = resolveArchiveFileBySessionId(queryOptions.sessionId);
      if (targetFile) {
        files.push(targetFile);
        return {
          files,
          dayStamps: [],
          usedIndex
        };
      }
    }

    const dayStamps = collectDayDirectories(archiveRootDir, queryOptions.days);
    let candidateFiles = listArchiveFilesByDays(archiveRootDir, dayStamps);
    if (queryOptions.queryMode !== 'legacy') {
      hydrateIndexForDays(archiveRootDir, dayStamps);
      if (index && typeof index.getCandidateFiles === 'function') {
        const indexedCandidates = index.getCandidateFiles({
          sessionId: queryOptions.sessionId,
          tabId: queryOptions.tabId,
          eventType: queryOptions.eventType,
          dayStamps
        })
          .filter((filePath) => fs.existsSync(filePath));
        if (indexedCandidates.length > 0) {
          candidateFiles = indexedCandidates;
          usedIndex = true;
        }
      }
    }

    files.push(...candidateFiles);
    return {
      files,
      dayStamps,
      usedIndex
    };
  }

  function upsertSessionMeta(payload = {}) {
    const sessionId = sanitizeLine(payload.sessionId, 120);
    if (!sessionId) return false;

    const state = readArchiveIndexState();
    const sessions = state.sessions && typeof state.sessions === 'object' ? state.sessions : {};
    const existing = sessions[sessionId] && typeof sessions[sessionId] === 'object'
      ? sessions[sessionId]
      : {};

    const nextEventCount = Math.max(0, Number(existing.eventCount) || 0) + (payload.incrementEventCount ? 1 : 0);
    const startedAt = sanitizeLine(payload.startedAt, 40) || sanitizeLine(existing.startedAt, 40) || new Date().toISOString();
    const lastAt = sanitizeLine(payload.lastAt, 40) || sanitizeLine(existing.lastAt, 40) || new Date().toISOString();
    const endedAt = payload.endedAt !== undefined
      ? (sanitizeLine(payload.endedAt, 40) || null)
      : (existing.endedAt || null);
    const tabId = sanitizeLine(payload.tabId, 80) || sanitizeLine(existing.tabId, 80) || '';
    const cwd = sanitizeLine(payload.cwd, 640) || sanitizeLine(existing.cwd, 640) || '';
    const isAiSession = payload.isAiSession !== undefined ? !!payload.isAiSession : !!existing.isAiSession;
    const cli = sanitizeLine(payload.cli, 40) || sanitizeLine(existing.cli, 40) || '';
    const provider = sanitizeLine(payload.provider, 40) || sanitizeLine(existing.provider, 40) || '';
    const model = sanitizeLine(payload.model, 80) || sanitizeLine(existing.model, 80) || '';
    const archivePath = sanitizeLine(payload.archivePath, 360) || sanitizeLine(existing.archivePath, 360) || '';
    const lastSummary = payload.lastSummary !== undefined
      ? sanitizeLine(payload.lastSummary, 180)
      : sanitizeLine(existing.lastSummary, 180);
    const lastAnalysis = payload.lastAnalysis !== undefined
      ? sanitizeLine(payload.lastAnalysis, 280)
      : sanitizeLine(existing.lastAnalysis, 280);
    const lastStatus = payload.lastStatus !== undefined
      ? sanitizeLine(payload.lastStatus, 40)
      : sanitizeLine(existing.lastStatus, 40);

    const nextState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: {
        ...sessions,
        [sessionId]: {
          sessionId,
          tabId,
          cwd,
          isAiSession,
          cli,
          provider,
          model,
          startedAt,
          endedAt,
          lastAt,
          eventCount: nextEventCount,
          lastSummary,
          lastAnalysis,
          lastStatus,
          archivePath
        }
      }
    };
    return writeArchiveIndexState(nextState);
  }

  function append(record, meta = {}) {
    const filePath = String(meta.filePath || '').trim();
    if (filePath && index && typeof index.addRecord === 'function') {
      index.addRecord(record, filePath);
    }
    if (meta.sessionMeta && typeof meta.sessionMeta === 'object') {
      upsertSessionMeta(meta.sessionMeta);
    }
  }

  function query(options = {}) {
    const startedAt = Date.now();
    const archiveRootDir = getArchiveRootDir();
    const normalized = normalizeQueryOptions(options);
    if (!archiveRootDir) {
      return {
        records: [],
        total: 0,
        query: normalized,
        stats: {
          queryMode: normalized.queryMode,
          filesScanned: 0,
          usedIndex: false,
          elapsedMs: Date.now() - startedAt
        }
      };
    }

    const resolved = collectFilesForQuery(archiveRootDir, normalized);
    const matched = [];
    for (const filePath of resolved.files) {
      const records = readJsonLines(filePath);
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        if (normalized.sessionId && record.sessionId !== normalized.sessionId) continue;
        if (normalized.tabId && record.tabId !== normalized.tabId) continue;
        if (normalized.cwd && !String(record.cwd || '').includes(normalized.cwd)) continue;
        if (normalized.eventType && record.eventType !== normalized.eventType) continue;
        if (normalized.keyword) {
          const haystack = `${record.summary || ''} ${record.analysis || ''} ${record.status || ''}`.toLowerCase();
          if (!haystack.includes(normalized.keyword)) continue;
        }
        matched.push(record);
      }
    }

    matched.sort((left, right) => String(right.ts || '').localeCompare(String(left.ts || '')));
    return {
      records: matched.slice(0, normalized.limit),
      total: matched.length,
      query: normalized,
      stats: {
        queryMode: normalized.queryMode,
        filesScanned: resolved.files.length,
        usedIndex: !!resolved.usedIndex,
        elapsedMs: Date.now() - startedAt
      }
    };
  }

  function summarizeInput(options = {}) {
    const result = query(options);
    const timeline = result.records
      .slice(0, 24)
      .reverse()
      .map((record) => `[${record.ts}] ${record.status || '进行中'} ${record.summary || ''} ${record.analysis || ''}`)
      .join('\n');
    return {
      result,
      timeline,
      stats: result.stats || null
    };
  }

  return {
    append,
    upsertSessionMeta,
    query,
    summarizeInput
  };
}

module.exports = {
  createJsonlStore
};
