const { app, BrowserWindow, ipcMain, Menu, dialog, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const topicDetector = require('./lib/topic-detector');

let win;
const terminals = new Map();
const confirmAlertAt = new Map();
const CONFIRM_ALERT_COOLDOWN_MS = 10000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;
const MIN_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const MAX_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const HEARTBEAT_MIN_CHARS = 80;
const HEARTBEAT_CONTEXT_TAIL_CHARS = 2600;
const HEARTBEAT_IDLE_GAP_MS = 12000;
const HEARTBEAT_NOTIFY_COOLDOWN_MS = 45000;
const HEARTBEAT_ARCHIVE_RETENTION_DAYS = 30;
const HEARTBEAT_MAX_QUERY_DAYS = 90;
const HEARTBEAT_MAX_QUERY_LIMIT = 200;
const HEARTBEAT_DEFAULT_QUERY_DAYS = 14;
const HEARTBEAT_DEFAULT_QUERY_LIMIT = 40;
const SESSION_ARCHIVE_DIRNAME = 'session-archive';
const heartbeatRuntime = {
  enabled: true,
  intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS
};
const HEARTBEAT_ERROR_PATTERN = /\b(error|failed|failure|exception|traceback|fatal|panic)\b|失败|错误|异常/i;
const HEARTBEAT_SUCCESS_PATTERN = /\b(done|success|completed|finished)\b|成功|完成|已完成/i;
const HEARTBEAT_WAITING_PATTERN = /是否继续|请确认|确认\?|are you sure|do you want to continue|yes\/no|y\/n|y\/N|Y\/n|confirm/i;
const HEARTBEAT_SIGNAL_PATTERNS = [HEARTBEAT_ERROR_PATTERN, HEARTBEAT_SUCCESS_PATTERN, HEARTBEAT_WAITING_PATTERN];
const archiveIndexState = {
  loaded: false,
  data: {
    version: 1,
    updatedAt: '',
    sessions: {}
  }
};

function toUnpackedPath(filePath) {
  return filePath
    .replace('app.asar', 'app.asar.unpacked')
    .replace('node_modules.asar', 'node_modules.asar.unpacked');
}

function setExecutableIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;

  try {
    const mode = fs.statSync(filePath).mode;
    const desiredMode = mode | 0o111;
    if (mode !== desiredMode) {
      fs.chmodSync(filePath, desiredMode);
    }
    return true;
  } catch (err) {
    console.warn('[pty] Failed to ensure executable permission:', filePath, err.message);
    return false;
  }
}

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return;

  const candidates = new Set();
  const archDirs = [`darwin-${process.arch}`, 'darwin-arm64', 'darwin-x64'];

  try {
    const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal');
    const libDir = path.dirname(unixTerminalPath);
    for (const archDir of archDirs) {
      candidates.add(path.resolve(libDir, '..', 'prebuilds', archDir, 'spawn-helper'));
    }
    candidates.add(path.resolve(libDir, '..', 'build', 'Release', 'spawn-helper'));
  } catch (err) {
    console.warn('[pty] Unable to resolve node-pty unixTerminal path:', err.message);
  }

  for (const archDir of archDirs) {
    candidates.add(path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds', archDir, 'spawn-helper'));
  }
  candidates.add(path.join(__dirname, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'));

  const expanded = new Set();
  for (const filePath of candidates) {
    expanded.add(filePath);
    expanded.add(toUnpackedPath(filePath));
  }

  let fixedCount = 0;
  for (const filePath of expanded) {
    if (setExecutableIfExists(filePath)) fixedCount += 1;
  }

  if (fixedCount > 0) {
    console.log(`[pty] Ensured executable permission on ${fixedCount} spawn-helper path(s).`);
  }
}

const CONFIRM_PROMPT_PATTERNS = [
  /\b(y\/n|yes\/no|y\/N|Y\/n)\b/,
  /(?:^|\s)\d+\.\s*yes,\s*proceed\s*\(y\)/i,
  /\byes,\s*proceed\s*\(y\)/i,
  /\bproceed\s*\(y\)/i,
  /are you sure/i,
  /do you want to continue/i,
  /\bproceed\?/i,
  /confirm/i,
  /继续\?/,
  /是否继续/,
  /是否确认/,
  /请确认/,
  /确认\?/
];

function stripAnsiForDetection(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x09\x0B-\x1F]/g, '');
}

function shouldNotifyConfirmPrompt(tabId, plainText) {
  const normalized = (plainText || '').trim();
  if (!normalized) return false;

  const matched = CONFIRM_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
  if (!matched) return false;

  const now = Date.now();
  const lastAt = confirmAlertAt.get(tabId) || 0;
  if (now - lastAt < CONFIRM_ALERT_COOLDOWN_MS) {
    return false;
  }

  confirmAlertAt.set(tabId, now);
  return true;
}

function createHeartbeatSignature(rawBuffer) {
  return stripAnsiForDetection(rawBuffer || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-HEARTBEAT_CONTEXT_TAIL_CHARS);
}

function hasHeartbeatSignal(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return HEARTBEAT_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function inferHeartbeatStatusFromText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '进行中';
  if (HEARTBEAT_ERROR_PATTERN.test(normalized)) return '异常';
  if (HEARTBEAT_WAITING_PATTERN.test(normalized)) return '待输入';
  if (HEARTBEAT_SUCCESS_PATTERN.test(normalized)) return '阶段完成';
  return '进行中';
}

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeArchiveLine(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function getArchiveRootDir() {
  return path.join(app.getPath('userData'), SESSION_ARCHIVE_DIRNAME);
}

function getArchiveIndexPath() {
  return path.join(getArchiveRootDir(), 'index.json');
}

function ensureDirSync(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (err) {
    console.warn('[heartbeat-archive] Failed to ensure directory:', dirPath, err.message);
    return false;
  }
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

function isoDayStamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function createSessionId(tabId) {
  const tabPart = String(tabId || 'tab')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-8) || 'tab';
  return `${Date.now().toString(36)}-${tabPart}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadArchiveIndex() {
  if (archiveIndexState.loaded) return archiveIndexState.data;

  const indexPath = getArchiveIndexPath();
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        archiveIndexState.data = {
          version: parsed.version || 1,
          updatedAt: parsed.updatedAt || '',
          sessions: parsed.sessions
        };
      }
    } catch (err) {
      console.warn('[heartbeat-archive] Failed to read index, recreating:', err.message);
    }
  }

  archiveIndexState.loaded = true;
  return archiveIndexState.data;
}

function persistArchiveIndex() {
  const root = getArchiveRootDir();
  if (!ensureDirSync(root)) return;
  const indexPath = getArchiveIndexPath();
  const data = loadArchiveIndex();
  data.updatedAt = new Date().toISOString();

  try {
    fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[heartbeat-archive] Failed to write index:', err.message);
  }
}

function ensureSessionArchiveFile(entry) {
  if (!entry) return false;
  if (entry.archiveFilePath && fs.existsSync(path.dirname(entry.archiveFilePath))) return true;

  const root = getArchiveRootDir();
  const day = isoDayStamp(entry.sessionStartedAt || Date.now());
  const dayDir = path.join(root, day);
  if (!ensureDirSync(dayDir)) return false;

  const safeSessionId = String(entry.sessionId || Date.now())
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  entry.archiveFilePath = path.join(dayDir, `${safeSessionId}.jsonl`);
  return true;
}

function upsertArchiveIndex(entry, patch = {}) {
  if (!entry || !entry.sessionId) return;

  const data = loadArchiveIndex();
  if (!data.sessions || typeof data.sessions !== 'object') {
    data.sessions = {};
  }

  const existing = data.sessions[entry.sessionId] || {};
  const archiveRoot = getArchiveRootDir();
  const relativeArchivePath = entry.archiveFilePath
    ? path.relative(archiveRoot, entry.archiveFilePath)
    : (existing.archivePath || '');
  const nextEventCount = (existing.eventCount || 0) + (patch.incrementEventCount ? 1 : 0);

  data.sessions[entry.sessionId] = {
    sessionId: entry.sessionId,
    tabId: entry.tabId || existing.tabId || '',
    cwd: entry.cwd || existing.cwd || '',
    isAiSession: !!entry.isAiSession,
    startedAt: entry.sessionStartedAt || existing.startedAt || new Date().toISOString(),
    endedAt: patch.endedAt !== undefined ? patch.endedAt : (existing.endedAt || null),
    lastAt: patch.lastAt || existing.lastAt || new Date().toISOString(),
    eventCount: nextEventCount,
    lastSummary: patch.lastSummary !== undefined ? patch.lastSummary : (existing.lastSummary || ''),
    lastAnalysis: patch.lastAnalysis !== undefined ? patch.lastAnalysis : (existing.lastAnalysis || ''),
    lastStatus: patch.lastStatus !== undefined ? patch.lastStatus : (existing.lastStatus || ''),
    archivePath: relativeArchivePath
  };

  persistArchiveIndex();
}

function appendHeartbeatArchiveRecord(tabId, entry, eventType, payload = {}) {
  if (!entry) return false;
  if (!entry.sessionId) {
    entry.sessionId = createSessionId(tabId);
  }
  if (!entry.sessionStartedAt) {
    entry.sessionStartedAt = new Date().toISOString();
  }
  entry.tabId = tabId;

  if (!ensureSessionArchiveFile(entry)) return false;

  const nowIso = new Date().toISOString();
  const summary = sanitizeArchiveLine(payload.summary, 180);
  const analysis = sanitizeArchiveLine(payload.analysis, 280);
  const status = sanitizeArchiveLine(payload.status, 40) || inferHeartbeatStatusFromText(`${summary}\n${analysis}`);
  const reason = sanitizeArchiveLine(payload.reason, 40);
  const source = sanitizeArchiveLine(payload.source, 40) || 'heartbeat';

  const record = {
    ts: nowIso,
    sessionId: entry.sessionId,
    tabId,
    cwd: entry.cwd || '',
    eventType: sanitizeArchiveLine(eventType, 40) || 'heartbeat',
    reason,
    source,
    status,
    summary,
    analysis
  };

  try {
    fs.appendFileSync(entry.archiveFilePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    console.warn('[heartbeat-archive] Failed to append record:', err.message);
    return false;
  }

  entry.archiveRecordCount = (entry.archiveRecordCount || 0) + 1;
  entry.lastArchiveRecordAt = nowIso;
  upsertArchiveIndex(entry, {
    incrementEventCount: true,
    lastAt: nowIso,
    endedAt: payload.endedAt,
    lastSummary: summary,
    lastAnalysis: analysis,
    lastStatus: status
  });
  return true;
}

function markSessionEnded(tabId, entry, eventType, detail = '') {
  if (!entry || entry.sessionEndedAt) return;
  const endedAt = new Date().toISOString();
  entry.sessionEndedAt = endedAt;

  const summaryMap = {
    tab_closed: '标签页已关闭，会话结束',
    session_exit: '终端会话已退出',
    app_shutdown: '应用关闭，会话已归档'
  };
  const summary = summaryMap[eventType] || '会话结束';
  const analysis = sanitizeArchiveLine(detail || '会话生命周期结束。', 220);
  appendHeartbeatArchiveRecord(tabId, entry, eventType, {
    summary,
    analysis,
    reason: eventType,
    source: 'system',
    endedAt
  });
}

function cleanupOldHeartbeatArchives() {
  const root = getArchiveRootDir();
  if (!fs.existsSync(root)) return;

  const cutoff = Date.now() - HEARTBEAT_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const item of entries) {
    if (!item.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.name)) continue;

    const dirTs = new Date(`${item.name}T00:00:00Z`).getTime();
    if (Number.isNaN(dirTs)) continue;
    if (dirTs >= cutoff) continue;

    try {
      fs.rmSync(path.join(root, item.name), { recursive: true, force: true });
    } catch (err) {
      console.warn('[heartbeat-archive] Failed to remove old archive dir:', item.name, err.message);
    }
  }
}

function collectArchiveFiles(days) {
  const root = getArchiveRootDir();
  if (!fs.existsSync(root)) return [];

  const now = Date.now();
  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  const dayDirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))
    .map((item) => item.name)
    .filter((stamp) => {
      const ts = new Date(`${stamp}T00:00:00Z`).getTime();
      return Number.isFinite(ts) && now - ts <= maxAgeMs;
    })
    .sort((a, b) => b.localeCompare(a));

  const files = [];
  for (const day of dayDirs) {
    const dirPath = path.join(root, day);
    const dayFiles = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((item) => item.isFile() && item.name.endsWith('.jsonl'))
      .map((item) => path.join(dirPath, item.name));
    files.push(...dayFiles);
  }
  return files;
}

function resolveSessionIdByTab(tabId) {
  const entry = terminals.get(tabId);
  return entry && entry.sessionId ? entry.sessionId : '';
}

function queryHeartbeatArchive(options = {}) {
  const days = clampInteger(options.days, 1, HEARTBEAT_MAX_QUERY_DAYS, HEARTBEAT_DEFAULT_QUERY_DAYS);
  const limit = clampInteger(options.limit, 1, HEARTBEAT_MAX_QUERY_LIMIT, HEARTBEAT_DEFAULT_QUERY_LIMIT);
  const keyword = sanitizeArchiveLine(options.keyword, 120).toLowerCase();
  const eventType = sanitizeArchiveLine(options.eventType, 40);
  const requestedTabId = sanitizeArchiveLine(options.tabId, 80);
  const cwd = sanitizeArchiveLine(options.cwd, 280);
  let sessionId = sanitizeArchiveLine(options.sessionId, 120);

  if (!sessionId && requestedTabId) {
    sessionId = resolveSessionIdByTab(requestedTabId);
  }

  const files = [];
  const archiveRoot = getArchiveRootDir();
  if (sessionId) {
    const index = loadArchiveIndex();
    const meta = index.sessions && index.sessions[sessionId];
    if (meta && meta.archivePath) {
      const targetFile = path.join(archiveRoot, meta.archivePath);
      if (fs.existsSync(targetFile)) {
        files.push(targetFile);
      }
    }
  }
  if (files.length === 0) {
    files.push(...collectArchiveFiles(days));
  }

  const matched = [];
  for (const filePath of files) {
    const records = readJsonLines(filePath);
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (sessionId && record.sessionId !== sessionId) continue;
      if (requestedTabId && record.tabId !== requestedTabId) continue;
      if (cwd && !String(record.cwd || '').includes(cwd)) continue;
      if (eventType && record.eventType !== eventType) continue;
      if (keyword) {
        const haystack = `${record.summary || ''} ${record.analysis || ''} ${record.status || ''}`.toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      matched.push(record);
    }
  }

  matched.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return {
    records: matched.slice(0, limit),
    total: matched.length,
    query: {
      days,
      limit,
      sessionId,
      tabId: requestedTabId,
      cwd,
      eventType,
      keyword
    }
  };
}

async function summarizeHeartbeatArchive(options = {}) {
  const result = queryHeartbeatArchive(options);
  if (result.records.length === 0) {
    return {
      ...result,
      summary: '当前查询范围暂无会话归档',
      analysis: '可以延长时间范围或先在会话中产生新的交互内容。'
    };
  }

  const timeline = result.records
    .slice(0, 24)
    .reverse()
    .map((record) => `[${record.ts}] ${record.status || '进行中'} ${record.summary || ''} ${record.analysis || ''}`)
    .join('\n');

  const report = await topicDetector.analyzeHeartbeat(timeline);
  return {
    ...result,
    summary: report.summary || '已提取会话心跳归档摘要',
    analysis: report.analysis || `已提取 ${result.records.length} 条归档记录。`
  };
}

function normalizeHeartbeatIntervalMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  return Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.round(n)));
}

function applyHeartbeatConfig(config = {}) {
  heartbeatRuntime.enabled = config.heartbeatEnabled !== false;
  heartbeatRuntime.intervalMs = normalizeHeartbeatIntervalMs(config.heartbeatIntervalMs);
}

async function runHeartbeat(tabId, entry, options = {}) {
  const reason = options.reason || 'interval';
  if (!entry || !entry.alive || entry.heartbeatInFlight) return;
  if (!heartbeatRuntime.enabled) return;
  if (entry.activitySeq <= entry.lastHeartbeatActivitySeq) return;

  const now = Date.now();
  const lastActivityAt = Math.max(entry.lastOutputAt || 0, entry.lastUserInputAt || 0);
  if (lastActivityAt > 0 && now - lastActivityAt < HEARTBEAT_IDLE_GAP_MS) return;

  const signature = createHeartbeatSignature(entry.buffer);
  const hasSignal = hasHeartbeatSignal(signature);
  if (signature.length < HEARTBEAT_MIN_CHARS && !hasSignal) return;
  if (signature === entry.lastHeartbeatSignature && !hasSignal) return;
  if (reason !== 'interval' && now - (entry.lastHeartbeatAt || 0) < HEARTBEAT_NOTIFY_COOLDOWN_MS && !hasSignal) {
    return;
  }

  entry.heartbeatInFlight = true;
  try {
    const activityMark = entry.activitySeq;
    const report = await topicDetector.analyzeHeartbeat(signature);

    entry.lastHeartbeatSignature = signature;
    entry.lastHeartbeatActivitySeq = activityMark;
    entry.lastHeartbeatAt = Date.now();
    entry.lastHeartbeatReport = report;
    appendHeartbeatArchiveRecord(tabId, entry, 'heartbeat', {
      summary: report.summary || '会话进行中',
      analysis: report.analysis || '请继续查看最新输出。',
      reason,
      source: 'background'
    });

    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:heartbeat-summary', {
        tabId,
        summary: report.summary || '会话进行中',
        analysis: report.analysis || '请继续查看最新输出。',
        source: 'background',
        reason,
        at: new Date().toISOString()
      });
    }
  } catch (err) {
    console.warn(`[heartbeat] Failed for tab ${tabId}:`, err.message);
  } finally {
    entry.heartbeatInFlight = false;
  }
}

function stopHeartbeat(entry) {
  if (!entry) return;
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }
  if (entry.heartbeatDebounceTimer) {
    clearTimeout(entry.heartbeatDebounceTimer);
    entry.heartbeatDebounceTimer = null;
  }
  entry.heartbeatInFlight = false;
}

function startHeartbeat(tabId, entry) {
  stopHeartbeat(entry);
  if (!heartbeatRuntime.enabled) return;
  entry.heartbeatTimer = setInterval(() => {
    runHeartbeat(tabId, entry, { reason: 'interval' }).catch((err) => {
      console.warn(`[heartbeat] Unexpected error for tab ${tabId}:`, err.message);
    });
  }, heartbeatRuntime.intervalMs);
}

function scheduleHeartbeatFromActivity(tabId, entry) {
  if (!entry || !entry.alive) return;
  if (!heartbeatRuntime.enabled) return;

  if (entry.heartbeatDebounceTimer) {
    clearTimeout(entry.heartbeatDebounceTimer);
  }

  entry.heartbeatDebounceTimer = setTimeout(() => {
    entry.heartbeatDebounceTimer = null;
    runHeartbeat(tabId, entry, { reason: 'activity' }).catch((err) => {
      console.warn(`[heartbeat] Debounced run failed for tab ${tabId}:`, err.message);
    });
  }, HEARTBEAT_IDLE_GAP_MS);
}

function restartAllHeartbeatTimers() {
  for (const [tabId, entry] of terminals.entries()) {
    startHeartbeat(tabId, entry);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      webSecurity: false  // Temporarily disable to test file drag-drop
    }
  });

  // Prevent default file drop behavior (opening files in window)
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    // If it's a file URL from drag-drop, extract the path and send to renderer
    if (url.startsWith('file://')) {
      const filePath = decodeURIComponent(url.replace('file://', ''));
      win.webContents.send('file:drop', { paths: [filePath] });
    }
  });

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  buildMenu();
}

// --- IPC: Directory picker ---

ipcMain.handle('dialog:select-directory', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择工作目录',
    buttonLabel: '选择'
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('dialog:confirm', async (event, { title, message, detail }) => {
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: title || '请确认',
    message: message || '请确认操作',
    detail: detail || '',
    buttons: ['取消', '确认'],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  });

  return { confirmed: result.response === 1 };
});

ipcMain.handle('notify:info', async (event, { title, body }) => {
  try {
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
      return { shown: false };
    }

    const notification = new Notification({
      title: title || 'ShaoTerm 提示',
      body: body || '',
      silent: false
    });
    notification.show();
    return { shown: true };
  } catch (err) {
    return { shown: false, error: err.message };
  }
});

// --- IPC: Terminal management ---

ipcMain.handle('terminal:create', (event, { tabId, cwd, autoCommand }) => {
  const shell = process.env.SHELL || '/bin/zsh';
  const resolvedCwd = cwd || process.env.HOME;
  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: { ...process.env, TERM: 'xterm-256color' }
  });

  const entry = {
    pty: ptyProcess,
    buffer: '',
    alive: true,
    isAiSession: !!autoCommand,
    cwd: resolvedCwd,
    tabId,
    sessionId: createSessionId(tabId),
    sessionStartedAt: new Date().toISOString(),
    sessionEndedAt: '',
    activitySeq: 0,
    lastHeartbeatActivitySeq: -1,
    lastOutputAt: Date.now(),
    lastUserInputAt: 0,
    heartbeatInFlight: false,
    heartbeatTimer: null,
    heartbeatDebounceTimer: null,
    lastHeartbeatSignature: '',
    lastHeartbeatAt: 0,
    lastHeartbeatReport: null
  };
  terminals.set(tabId, entry);
  startHeartbeat(tabId, entry);
  appendHeartbeatArchiveRecord(tabId, entry, 'session_start', {
    summary: '会话已启动',
    analysis: `工作目录：${sanitizeArchiveLine(resolvedCwd, 160) || '默认目录'}`,
    reason: entry.isAiSession ? 'ai_session' : 'terminal_session',
    source: 'system'
  });

  ptyProcess.onData((data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:output', { tabId, data });
    }
    // Append to rolling buffer (keep last 4000 raw chars, strip on read)
    entry.buffer += data;
    if (entry.buffer.length > 4000) {
      entry.buffer = entry.buffer.slice(-4000);
    }

    const plain = stripAnsiForDetection(data);
    if (plain.trim()) {
      entry.activitySeq += 1;
      entry.lastOutputAt = Date.now();
      scheduleHeartbeatFromActivity(tabId, entry);
    }

    if (shouldNotifyConfirmPrompt(tabId, plain) && win && !win.isDestroyed()) {
      appendHeartbeatArchiveRecord(tabId, entry, 'confirm_prompt', {
        summary: '检测到确认类提示',
        analysis: sanitizeArchiveLine(plain.slice(-220), 220),
        reason: 'confirm_signal',
        source: 'detector',
        status: '待输入'
      });
      win.webContents.send('terminal:confirm-needed', {
        tabId,
        prompt: plain.slice(-160).trim()
      });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    entry.alive = false;
    markSessionEnded(tabId, entry, 'session_exit', `退出码：${exitCode}`);
    stopHeartbeat(entry);
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:closed', { tabId, exitCode });
    }
  });

  // Auto-run command after shell initializes (if specified)
  if (autoCommand) {
    setTimeout(() => {
      if (entry.alive) {
        ptyProcess.write(autoCommand + '\r');
      }
    }, 500);
  }

  // Workaround: nudge window size to force xterm.js relayout.
  // xterm.js in Electron sometimes doesn't calculate dimensions correctly
  // on first render; a tiny resize triggers proper recalculation.
  if (win && !win.isDestroyed()) {
    const [w, h] = win.getSize();
    win.setSize(w + 1, h + 1);
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.setSize(w, h);
      }
    }, 50);
  }

  return { tabId };
});

ipcMain.on('terminal:data', (event, { tabId, data }) => {
  const entry = terminals.get(tabId);
  if (entry && entry.alive) {
    if ((data || '').trim()) {
      entry.activitySeq += 1;
      entry.lastUserInputAt = Date.now();
      scheduleHeartbeatFromActivity(tabId, entry);
    }
    entry.pty.write(data);
  }
});

ipcMain.on('terminal:resize', (event, { tabId, cols, rows }) => {
  const entry = terminals.get(tabId);
  if (entry && entry.alive) {
    entry.pty.resize(cols, rows);
  }
});

ipcMain.handle('terminal:close', (event, { tabId }) => {
  const entry = terminals.get(tabId);
  if (entry) {
    markSessionEnded(tabId, entry, 'tab_closed');
    stopHeartbeat(entry);
    if (entry.alive) {
      entry.pty.kill();
    }
    terminals.delete(tabId);
  }
  confirmAlertAt.delete(tabId);
  return { tabId };
});

// --- IPC: Topic detection ---

ipcMain.handle('topic:refresh', async () => {
  const tabBuffers = [];
  for (const [tabId, entry] of terminals) {
    tabBuffers.push({ tabId, buffer: entry.buffer });
  }

  try {
    const results = await topicDetector.detectTopics(tabBuffers);
    for (const { tabId, topic } of results) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('topic:status', {
          tabId, status: 'done', topic
        });
      }
    }
    return { success: true };
  } catch (err) {
    for (const { tabId } of tabBuffers) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('topic:status', {
          tabId, status: 'error', topic: '新对话'
        });
      }
    }
    return { success: false, error: err.message };
  }
});

// --- IPC: Settings ---

ipcMain.handle('settings:get', () => {
  applyHeartbeatConfig(topicDetector.getConfig());
  return topicDetector.getConfig();
});

ipcMain.handle('settings:save', (event, { apiKey, baseUrl, aiCommand, heartbeat }) => {
  topicDetector.configure(apiKey, baseUrl, aiCommand, heartbeat || {});
  applyHeartbeatConfig(topicDetector.getConfig());
  restartAllHeartbeatTimers();
  return { success: true };
});

// --- IPC: Heartbeat archive ---

ipcMain.handle('heartbeat:query', (event, options = {}) => {
  try {
    return queryHeartbeatArchive(options);
  } catch (err) {
    return { records: [], total: 0, query: {}, error: err.message };
  }
});

ipcMain.handle('heartbeat:summarize', async (event, options = {}) => {
  try {
    return await summarizeHeartbeatArchive(options);
  } catch (err) {
    return {
      records: [],
      total: 0,
      query: {},
      summary: '会话归档总结失败',
      analysis: `原因：${err.message}`
    };
  }
});

// --- Menu & Shortcuts ---

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '文件',
      submenu: [
        {
          label: '新建 AI 标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            if (win) win.webContents.send('shortcut:new-tab');
          }
        },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (win) win.webContents.send('shortcut:close-tab');
          }
        }
      ]
    },
    {
      label: '查看',
      submenu: [
        {
          label: '刷新标签分析',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (win) win.webContents.send('shortcut:refresh-topics');
          }
        },
        {
          label: '提取当前会话心跳归档',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            if (win) win.webContents.send('shortcut:show-heartbeat-archive');
          }
        },
        { type: 'separator' },
        {
          label: '放大字体',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            if (win) win.webContents.send('shortcut:increase-font');
          }
        },
        {
          label: '缩小字体',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            if (win) win.webContents.send('shortcut:decrease-font');
          }
        },
        {
          label: '重置字体大小',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            if (win) win.webContents.send('shortcut:reset-font');
          }
        },
        { type: 'separator' },
        {
          label: '上一个标签',
          accelerator: 'CmdOrCtrl+Alt+Left',
          click: () => {
            console.log('Prev tab menu clicked');
            if (win) win.webContents.send('shortcut:prev-tab');
          }
        },
        {
          label: '下一个标签',
          accelerator: 'CmdOrCtrl+Alt+Right',
          click: () => {
            console.log('Next tab menu clicked');
            if (win) win.webContents.send('shortcut:next-tab');
          }
        },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `标签页 ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => {
            if (win) win.webContents.send('shortcut:switch-tab', { index: i });
          }
        })),
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- App lifecycle ---

app.whenReady().then(() => {
  ensureNodePtySpawnHelperExecutable();
  applyHeartbeatConfig(topicDetector.getConfig());
  cleanupOldHeartbeatArchives();
  createWindow();
});

app.on('before-quit', () => {
  for (const [tabId, entry] of terminals) {
    markSessionEnded(tabId, entry, 'app_shutdown');
  }
});

app.on('window-all-closed', () => {
  for (const [tabId, entry] of terminals) {
    markSessionEnded(tabId, entry, 'app_shutdown');
    if (entry.alive) entry.pty.kill();
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Handle file drops on macOS (native API)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  console.log('File dropped via open-file event:', filePath);

  // Send the full file path to the active window
  if (win && !win.isDestroyed()) {
    win.webContents.send('file:drop', { paths: [filePath] });
  }
});
