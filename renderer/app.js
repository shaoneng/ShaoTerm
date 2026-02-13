/* global TerminalManager */

(function appRendererScope() {

// --- Debug Logging System ---
const DEBUG_MODE_STORAGE_KEY = 'shaoterm.debug-mode.v1';
const DEBUG_MODE_QUERY_KEY = 'debug';
const DEBUG_MODE = (() => {
  try {
    const search = new URLSearchParams(window.location.search || '');
    if (search.get(DEBUG_MODE_QUERY_KEY) === '1') return true;
    return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === '1';
  } catch (err) {
    return false;
  }
})();

const debugLogs = [];
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info
};

function debugLog(...args) {
  if (!DEBUG_MODE) return;
  originalConsole.log.apply(console, args);
}

function addLog(type, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch (e) {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');

  debugLogs.push({ timestamp, type, message });

  // Keep only last 500 logs
  if (debugLogs.length > 500) {
    debugLogs.shift();
  }
}

if (DEBUG_MODE) {
  // Override console methods only in debug mode.
  console.log = function(...args) {
    addLog('log', ...args);
    originalConsole.log.apply(console, args);
  };

  console.error = function(...args) {
    addLog('error', ...args);
    originalConsole.error.apply(console, args);
  };

  console.warn = function(...args) {
    addLog('warn', ...args);
    originalConsole.warn.apply(console, args);
  };

  console.info = function(...args) {
    addLog('info', ...args);
    originalConsole.info.apply(console, args);
  };

  // Capture unhandled errors
  window.addEventListener('error', (event) => {
    addLog('error', `Unhandled error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    addLog('error', `Unhandled promise rejection: ${event.reason}`);
  });

  console.log('Debug logging system initialized');
}

// --- App State ---

function createFallbackTerminalManager() {
  return {
    __isFallback: true,
    create() {
      throw new Error('终端渲染内核未加载');
    },
    write() {},
    fit() { return null; },
    focus() {},
    getScrollDistance() { return 0; },
    onScrollStateChange() { return () => {}; },
    isNearBottom() { return true; },
    ensureInputVisible() {},
    scrollToBottom() {},
    destroy() {},
    setLightMode() {},
    increaseFontSize() {},
    decreaseFontSize() {},
    resetFontSize() {}
  };
}

const terminalManager = (() => {
  if (typeof TerminalManager === 'function') {
    try {
      return new TerminalManager();
    } catch (err) {
      console.warn('Failed to initialize TerminalManager, fallback to stub manager:', err);
      return createFallbackTerminalManager();
    }
  }
  console.warn('TerminalManager global is missing, fallback to stub manager.');
  return createFallbackTerminalManager();
})();
const tabs = []; // { id, title, manuallyRenamed, cwd, autoCommand, heartbeatStatus, heartbeatSummary, heartbeatAnalysis, heartbeatAt, sessionReady, sessionState, sessionStartPromise, pendingAutoCommand }
const pendingTopicRefreshTabs = new Set();
let activeTabId = null;
let inAppNoticeContainer = null;
const TAB_SNAPSHOT_KEY = 'shaoterm.tab-snapshot.v1';
const TAB_SNAPSHOT_SCHEMA_VERSION = 2;
let isRestoringTabs = false;
let pendingTabSnapshotPayload = null;
let tabSnapshotPersistTimer = null;
let tabSnapshotFlushInFlight = false;

// DOM references
const tabBar = document.getElementById('tab-bar');
const btnAddTerminal = document.getElementById('btn-add-terminal');
const btnAddAi = document.getElementById('btn-add-ai');
const terminalContainer = document.getElementById('terminal-container');
const btnSettings = document.getElementById('btn-settings');
const btnScrollBottom = document.getElementById('btn-scroll-bottom');
const settingsModal = document.getElementById('settings-modal');
const settingsAiCommand = document.getElementById('settings-ai-command');
const settingsBaseUrl = document.getElementById('settings-base-url');
const settingsApiKey = document.getElementById('settings-api-key');
const btnSettingsSave = document.getElementById('btn-settings-save');
const btnSettingsCancel = document.getElementById('btn-settings-cancel');
const quickHeartbeatEnabled = document.getElementById('quick-heartbeat-enabled');
const quickHeartbeatInterval = document.getElementById('quick-heartbeat-interval');
const UI_REQUIRED_ELEMENTS = [
  ['tab-bar', tabBar],
  ['terminal-container', terminalContainer],
  ['btn-add-terminal', btnAddTerminal],
  ['btn-add-ai', btnAddAi],
  ['btn-settings', btnSettings],
  ['settings-modal', settingsModal]
];
let aiCommand = 'codex';
const HEARTBEAT_INTERVAL_OPTIONS = ['5', '10', '15', '30'];
const TERMINAL_BOTTOM_SNAP_LINES = 2;
const TERMINAL_CREATE_TIMEOUT_MS = 12000;
const STARTUP_PHASE_DELAY_MS = 0;
const STARTUP_FAST_SHELL_MODE = 'fast';
const HEARTBEAT_STATUS_TEXT = {
  unknown: '暂无心跳',
  running: '进行中',
  waiting: '待输入',
  success: '阶段完成',
  error: '异常',
  ended: '已结束'
};

function normalizeHeartbeatStatus(status, fallbackText = '') {
  const raw = String(status || fallbackText || '').trim();
  if (!raw) return 'unknown';
  if (/(异常|error|failed|failure|fatal|panic|traceback)/i.test(raw)) return 'error';
  if (/(待输入|waiting|confirm|yes\/no|y\/n|是否继续|请确认)/i.test(raw)) return 'waiting';
  if (/(阶段完成|success|done|completed|finished|完成)/i.test(raw)) return 'success';
  if (/(已结束|ended|exit|closed)/i.test(raw)) return 'ended';
  if (/(进行中|running|progress)/i.test(raw)) return 'running';
  return 'running';
}

function formatHeartbeatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatHeartbeatTooltip(tabData) {
  if (!tabData) return '';
  const status = HEARTBEAT_STATUS_TEXT[tabData.heartbeatStatus || 'unknown'] || HEARTBEAT_STATUS_TEXT.unknown;
  const at = formatHeartbeatTime(tabData.heartbeatAt);
  const summary = String(tabData.heartbeatSummary || '').trim();
  const analysis = String(tabData.heartbeatAnalysis || '').trim();
  const cwd = String(tabData.cwd || '').trim();
  const lines = [];
  if (cwd) lines.push(`目录：${cwd}`);
  lines.push(`心跳：${status}${at ? ` · ${at}` : ''}`);
  if (summary) lines.push(`总结：${summary}`);
  if (analysis) lines.push(`分析：${analysis}`);
  return lines.join('\n');
}

function getTabFolderName(tabData) {
  const cwd = String((tabData && tabData.cwd) || '').trim();
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function renderTabLabel(tabId, analyzing = false) {
  const tabData = tabs.find((t) => t.id === tabId);
  if (!tabData) return;
  const tabEl = tabBar.querySelector(`.tab[data-tab-id="${tabId}"]`);
  if (!tabEl) return;

  const titleSpan = tabEl.querySelector('.tab-title');
  if (titleSpan) {
    titleSpan.textContent = tabData.title;
    titleSpan.classList.toggle('analyzing', !!analyzing);
  }

  const folderSpan = tabEl.querySelector('.tab-folder');
  if (folderSpan) {
    const folderName = getTabFolderName(tabData);
    const shouldShowFolder = !!folderName && folderName !== tabData.title;
    folderSpan.textContent = folderName;
    folderSpan.classList.toggle('hidden', !shouldShowFolder);
  }
}

function renderTabHeartbeat(tabId) {
  const tabData = tabs.find((t) => t.id === tabId);
  if (!tabData) return;
  const tabEl = tabBar.querySelector(`.tab[data-tab-id="${tabId}"]`);
  if (!tabEl) return;

  const dotEl = tabEl.querySelector('.tab-heartbeat-dot');
  if (dotEl) {
    dotEl.className = `tab-heartbeat-dot status-${tabData.heartbeatStatus || 'unknown'}`;
    dotEl.setAttribute('aria-label', HEARTBEAT_STATUS_TEXT[tabData.heartbeatStatus || 'unknown'] || HEARTBEAT_STATUS_TEXT.unknown);
  }

  tabEl.title = formatHeartbeatTooltip(tabData);
}

function updateTabHeartbeatMeta(tabId, patch = {}) {
  const tabData = tabs.find((t) => t.id === tabId);
  if (!tabData) return;
  if (patch.status !== undefined) {
    tabData.heartbeatStatus = normalizeHeartbeatStatus(patch.status, `${patch.summary || ''}\n${patch.analysis || ''}`);
  }
  if (patch.summary !== undefined) {
    tabData.heartbeatSummary = String(patch.summary || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  if (patch.analysis !== undefined) {
    tabData.heartbeatAnalysis = String(patch.analysis || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  }
  if (patch.at !== undefined) {
    tabData.heartbeatAt = String(patch.at || '').trim();
  } else if (patch.status !== undefined || patch.summary !== undefined || patch.analysis !== undefined) {
    tabData.heartbeatAt = new Date().toISOString();
  }
  renderTabHeartbeat(tabId);
}

function updateScrollBottomButton(distanceToBottom) {
  if (distanceToBottom > 0 && distanceToBottom <= TERMINAL_BOTTOM_SNAP_LINES) {
    terminalManager.scrollToBottom(activeTabId);
    return;
  }
  btnScrollBottom.classList.toggle('visible', distanceToBottom > TERMINAL_BOTTOM_SNAP_LINES);
}

function syncScrollBottomButton() {
  if (!activeTabId) {
    btnScrollBottom.classList.remove('visible');
    return;
  }
  const distanceToBottom = terminalManager.getScrollDistance(activeTabId);
  updateScrollBottomButton(distanceToBottom);
}

function handleTerminalScrollStateChange({ tabId, distanceToBottom }) {
  if (tabId !== activeTabId) return;
  updateScrollBottomButton(distanceToBottom);
}

function normalizeHeartbeatIntervalMs(value) {
  const ms = Number(value);
  const roundedMinutes = Math.round((Number.isFinite(ms) ? ms : 10 * 60 * 1000) / 60000);
  const normalizedMinutes = HEARTBEAT_INTERVAL_OPTIONS.includes(String(roundedMinutes)) ? roundedMinutes : 10;
  return normalizedMinutes * 60 * 1000;
}

function normalizeRuntimeSettings(config = {}) {
  return {
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || '',
    aiCommand: normalizeAiCommand(config.aiCommand),
    heartbeatEnabled: config.heartbeatEnabled !== false,
    heartbeatIntervalMs: normalizeHeartbeatIntervalMs(config.heartbeatIntervalMs),
    heartbeatPreferSessionAi: config.heartbeatPreferSessionAi !== false
  };
}

function applyQuickSettings(config = {}) {
  if (quickHeartbeatEnabled) {
    quickHeartbeatEnabled.checked = config.heartbeatEnabled !== false;
  }

  if (quickHeartbeatInterval) {
    const minutes = Math.round((Number(config.heartbeatIntervalMs) || 10 * 60 * 1000) / 60000);
    quickHeartbeatInterval.value = HEARTBEAT_INTERVAL_OPTIONS.includes(String(minutes))
      ? String(minutes)
      : '10';
  }
}

async function persistRuntimeSettings(config) {
  const normalized = normalizeRuntimeSettings(config);
  aiCommand = normalized.aiCommand;
  await window.api.saveSettings(normalized.apiKey, normalized.baseUrl, normalized.aiCommand, {
    heartbeatEnabled: normalized.heartbeatEnabled,
    heartbeatIntervalMs: normalized.heartbeatIntervalMs,
    heartbeatPreferSessionAi: normalized.heartbeatPreferSessionAi
  });
  applyQuickSettings(normalized);
  return normalized;
}

// --- Tab Management ---

function generateTabId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 6);
}

function normalizeAiCommand(value) {
  const normalized = (value || '').trim();
  return normalized || 'codex';
}

function normalizeOptionalCommand(value) {
  return String(value || '').trim();
}

function syncTabAutoCommand(tabData, nextCommand, source = 'session_profile') {
  if (!tabData) return false;
  const normalizedNext = normalizeOptionalCommand(nextCommand);
  if (!normalizedNext) return false;

  const normalizedCurrent = normalizeOptionalCommand(tabData.autoCommand);
  if (normalizedCurrent === normalizedNext) return false;

  tabData.autoCommand = normalizedNext;
  debugLog(`[tab][auto-command] ${tabData.title || tabData.id} -> ${normalizedNext} (${source})`);
  persistTabSnapshot({ immediate: true });
  return true;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message || '请求超时'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatErrorDetail(err, fallback = '未知错误') {
  if (err && err.message) {
    return String(err.message).replace(/\s+/g, ' ').trim().slice(0, 220) || fallback;
  }
  return fallback;
}

function hasApiMethod(methodName) {
  return !!(window.api && typeof window.api[methodName] === 'function');
}

function registerApiListener(methodName, callback) {
  if (!hasApiMethod(methodName)) {
    console.warn(`[api] Missing listener bridge: ${methodName}`);
    return false;
  }
  try {
    window.api[methodName](callback);
    return true;
  } catch (err) {
    console.warn(`[api] Failed to register listener bridge: ${methodName}`, err);
    return false;
  }
}

function createTabSnapshot() {
  return {
    version: TAB_SNAPSHOT_SCHEMA_VERSION,
    activeTabId: activeTabId || '',
    tabs: tabs.map((tab) => ({
      tabId: tab.id,
      title: tab.title,
      manuallyRenamed: !!tab.manuallyRenamed,
      cwd: tab.cwd || '',
      lastCliCommand: tab.autoCommand || '',
      autoCommand: tab.autoCommand || ''
    }))
  };
}

function normalizeTabSnapshot(snapshot) {
  const raw = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
  const tabsList = rawTabs
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const tabId = String(item.tabId || item.id || `tab-${index + 1}`).trim();
      const title = String(item.title || '').trim() || '终端';
      const cwd = String(item.cwd || '').trim();
      const lastCliCommand = String(item.lastCliCommand || item.autoCommand || '').trim();
      return {
        tabId,
        title,
        manuallyRenamed: !!item.manuallyRenamed,
        cwd,
        lastCliCommand,
        autoCommand: lastCliCommand
      };
    })
    .filter(Boolean);

  let activeTabId = String(raw.activeTabId || '').trim();
  if (!activeTabId && Number.isInteger(raw.activeIndex)) {
    const fromIndex = tabsList[raw.activeIndex];
    activeTabId = fromIndex ? fromIndex.tabId : '';
  }
  if (activeTabId && !tabsList.some((tab) => tab.tabId === activeTabId)) {
    activeTabId = '';
  }
  if (!activeTabId && tabsList.length > 0) {
    activeTabId = tabsList[tabsList.length - 1].tabId;
  }

  return {
    version: TAB_SNAPSHOT_SCHEMA_VERSION,
    activeTabId,
    tabs: tabsList
  };
}

async function flushPendingTabSnapshot() {
  if (tabSnapshotFlushInFlight) return;
  const payload = pendingTabSnapshotPayload;
  if (!payload) return;
  if (!hasApiMethod('saveTabSnapshot')) return;

  pendingTabSnapshotPayload = null;
  tabSnapshotFlushInFlight = true;
  try {
    await window.api.saveTabSnapshot(payload);
  } catch (err) {
    console.warn('Failed to persist tab snapshot to main process:', err);
    pendingTabSnapshotPayload = payload;
  } finally {
    tabSnapshotFlushInFlight = false;
    if (pendingTabSnapshotPayload) {
      setTimeout(() => {
        flushPendingTabSnapshot().catch((flushErr) => {
          console.warn('Failed to retry tab snapshot flush:', flushErr);
        });
      }, 180);
    }
  }
}

function persistTabSnapshot(options = {}) {
  if (isRestoringTabs) return;
  const snapshot = createTabSnapshot();
  const immediate = !!options.immediate;

  pendingTabSnapshotPayload = snapshot;
  try {
    // Keep local backup for one-time migration / emergency fallback.
    window.localStorage.setItem(TAB_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('Failed to persist tab snapshot to localStorage backup:', err);
  }

  if (immediate) {
    if (tabSnapshotPersistTimer) {
      clearTimeout(tabSnapshotPersistTimer);
      tabSnapshotPersistTimer = null;
    }
    flushPendingTabSnapshot().catch((flushErr) => {
      console.warn('Failed to flush tab snapshot immediately:', flushErr);
    });
    return;
  }

  if (tabSnapshotPersistTimer) return;
  tabSnapshotPersistTimer = setTimeout(() => {
    tabSnapshotPersistTimer = null;
    flushPendingTabSnapshot().catch((flushErr) => {
      console.warn('Failed to flush tab snapshot:', flushErr);
    });
  }, 160);
}

function loadLegacyLocalSnapshot() {
  try {
    const raw = window.localStorage.getItem(TAB_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const normalized = normalizeTabSnapshot(parsed);
    if (!Array.isArray(normalized.tabs) || normalized.tabs.length === 0) return null;
    return normalized;
  } catch (err) {
    console.warn('Failed to parse legacy local tab snapshot:', err);
    return null;
  }
}

async function loadTabSnapshot() {
  if (hasApiMethod('getTabSnapshot')) {
    try {
      const remoteSnapshot = await window.api.getTabSnapshot();
      const normalizedRemote = normalizeTabSnapshot(remoteSnapshot);
      if (Array.isArray(normalizedRemote.tabs) && normalizedRemote.tabs.length > 0) {
        return normalizedRemote;
      }
    } catch (err) {
      console.warn('Failed to load tab snapshot from main process:', err);
    }
  }

  const legacySnapshot = loadLegacyLocalSnapshot();
  if (!legacySnapshot) return null;

  if (hasApiMethod('saveTabSnapshot')) {
    pendingTabSnapshotPayload = legacySnapshot;
    flushPendingTabSnapshot().catch((err) => {
      console.warn('Failed to migrate legacy tab snapshot to main process:', err);
    });
  }

  return legacySnapshot;
}

function resolveSnapshotActiveIndex(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) return -1;
  const targetId = String(snapshot.activeTabId || '').trim();
  if (targetId) {
    const index = snapshot.tabs.findIndex((tab) => String(tab.tabId || '').trim() === targetId);
    if (index >= 0) return index;
  }
  return Math.max(snapshot.tabs.length - 1, 0);
}

async function restoreTabsFromSnapshot() {
  const snapshot = await loadTabSnapshot();
  if (!snapshot) return false;

  isRestoringTabs = true;
  let restoredCount = 0;
  const snapshotTabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  if (snapshotTabs.length === 0) {
    isRestoringTabs = false;
    return false;
  }

  const activeIndex = resolveSnapshotActiveIndex(snapshot);

  try {
    // Restore tab headers in original order, but only active tab starts its session immediately.
    for (let i = 0; i < snapshotTabs.length; i += 1) {
      const tab = snapshotTabs[i];
      const isActiveTab = i === activeIndex;
      try {
        const restoredId = await createNewTab({
          title: tab.title || '终端',
          manuallyRenamed: !!tab.manuallyRenamed,
          cwd: tab.cwd || null,
          autoCommand: tab.lastCliCommand || tab.autoCommand || null,
          skipDirectoryPrompt: true,
          activate: isActiveTab,
          deferSessionStart: !isActiveTab,
          deferAutoRun: true,
          deferPendingCommandFlush: true,
          shellMode: STARTUP_FAST_SHELL_MODE
        });
        if (restoredId) restoredCount += 1;
      } catch (tabErr) {
        console.warn('Failed to restore one tab from snapshot:', tabErr, tab);
      }
    }
  } catch (err) {
    console.warn('Failed while restoring tabs from snapshot:', err);
  } finally {
    isRestoringTabs = false;
  }

  if (restoredCount === 0) {
    return false;
  }

  if (Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < tabs.length) {
    switchToTabById(tabs[activeIndex].id);
  } else if (tabs.length > 0) {
    switchToTabById(tabs[tabs.length - 1].id);
  }

  persistTabSnapshot();
  return true;
}

function ensureFailureWrapper(tabId, existingWrapper) {
  if (existingWrapper && existingWrapper.parentNode) {
    return existingWrapper;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.tabId = tabId;
  terminalContainer.appendChild(wrapper);
  return wrapper;
}

function getTabDataById(tabId) {
  return tabs.find((t) => t.id === tabId) || null;
}

function getTabWrapper(tabId) {
  return terminalContainer.querySelector(`.terminal-wrapper[data-tab-id="${tabId}"]`);
}

function setActiveTabVisual(tabId) {
  tabBar.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });
  terminalContainer.querySelectorAll('.terminal-wrapper').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });
}

async function runPendingAutoCommandIfNeeded(tabData) {
  if (!tabData || !tabData.sessionReady) return;
  const pendingCommand = String(tabData.pendingAutoCommand || '').trim();
  if (!pendingCommand) return;
  tabData.pendingAutoCommand = '';
  window.api.sendTerminalData(tabData.id, `${pendingCommand}\r`);
}

function renderSessionFailureState(tabId, wrapper, title, detail) {
  const safeTitle = String(title || '会话创建失败').trim() || '会话创建失败';
  const safeDetail = String(detail || '未知错误').replace(/\s+/g, ' ').trim().slice(0, 260) || '未知错误';
  const failureWrapper = ensureFailureWrapper(tabId, wrapper);
  failureWrapper.innerHTML = '';
  failureWrapper.classList.add('active');

  const panel = document.createElement('div');
  panel.className = 'session-error-state';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-error-title';
  titleEl.textContent = safeTitle;

  const detailEl = document.createElement('div');
  detailEl.className = 'session-error-detail';
  detailEl.textContent = safeDetail;

  panel.appendChild(titleEl);
  panel.appendChild(detailEl);
  failureWrapper.appendChild(panel);

  updateTabHeartbeatMeta(tabId, {
    status: 'error',
    summary: safeTitle,
    analysis: safeDetail,
    at: new Date().toISOString()
  });
  showInAppNotice(safeTitle, safeDetail);
  syncScrollBottomButton();
  persistTabSnapshot();
}

async function ensureTabSessionReady(tabData, options = {}) {
  if (!tabData) return false;
  if (tabData.sessionReady) {
    if (options.runPendingCommand !== false) {
      await runPendingAutoCommandIfNeeded(tabData);
    }
    return true;
  }
  if (tabData.sessionStartPromise) {
    const ready = await tabData.sessionStartPromise;
    if (ready && options.runPendingCommand !== false) {
      await runPendingAutoCommandIfNeeded(tabData);
    }
    return !!ready;
  }

  const tabId = tabData.id;
  const wrapper = ensureFailureWrapper(tabId, getTabWrapper(tabId));
  wrapper.innerHTML = '';
  tabData.sessionState = 'starting';

  const startPromise = (async () => {
    let cols = 80;
    let rows = 24;
    try {
      const size = terminalManager.create(tabId, wrapper);
      cols = size.cols;
      rows = size.rows;
    } catch (err) {
      console.warn('Failed to initialize terminal view:', err);
      tabData.sessionState = 'error';
      renderSessionFailureState(
        tabId,
        wrapper,
        '终端加载失败',
        `终端渲染组件初始化失败：${formatErrorDetail(err, '请重启应用后重试。')}`
      );
      return false;
    }

    let createResult = null;
    try {
      createResult = await withTimeout(
        window.api.createTerminal(
          tabId,
          tabData.cwd,
          tabData.autoCommand || null,
          {
            shellMode: options.shellMode || tabData.shellMode || '',
            autoRunCommand: options.autoRunCommand !== false
          }
        ),
        TERMINAL_CREATE_TIMEOUT_MS,
        `终端创建超时（>${Math.round(TERMINAL_CREATE_TIMEOUT_MS / 1000)} 秒）`
      );
    } catch (err) {
      console.warn('Failed to create terminal session:', err);
      tabData.sessionState = 'error';
      terminalManager.destroy(tabId);
      if (hasApiMethod('closeTerminal')) {
        window.api.closeTerminal(tabId).catch((closeErr) => {
          console.warn('Failed to cleanup timed-out/failed terminal session:', closeErr);
        });
      }
      renderSessionFailureState(
        tabId,
        wrapper,
        '会话创建失败',
        `无法创建终端会话：${formatErrorDetail(err)}`
      );
      return false;
    }

    if (createResult && createResult.resolvedCwd) {
      tabData.cwd = createResult.resolvedCwd;
      renderTabLabel(tabId);
    }
    if (createResult && createResult.cwdFallbackApplied) {
      const requestedPath = String(createResult.requestedCwd || '').trim();
      const fallbackPath = String(createResult.resolvedCwd || '').trim();
      const fallbackMessage = requestedPath
        ? `目录不可用，已自动切换到：${fallbackPath}`
        : `未提供目录，已使用默认目录：${fallbackPath}`;
      showInAppNotice('目录已自动回退', fallbackMessage);
    }

    tabData.sessionReady = true;
    tabData.sessionState = 'running';
    tabData.shellMode = '';
    updateTabHeartbeatMeta(tabId, {
      status: 'running',
      summary: '会话已启动',
      analysis: tabData.cwd ? `工作目录：${tabData.cwd}` : '',
      at: new Date().toISOString()
    });

    if (options.autoRunCommand === false && tabData.autoCommand) {
      tabData.pendingAutoCommand = tabData.autoCommand;
    }

    window.api.resizeTerminal(tabId, cols, rows);
    if (activeTabId === tabId) {
      terminalManager.focus(tabId);
    }

    return true;
  })();

  tabData.sessionStartPromise = startPromise;
  const ready = await startPromise;
  tabData.sessionStartPromise = null;

  if (ready && options.runPendingCommand !== false) {
    await runPendingAutoCommandIfNeeded(tabData);
  }

  syncScrollBottomButton();
  persistTabSnapshot();
  return !!ready;
}

async function createNewTab(options = {}) {
  try {
    const resolvedOptions = typeof options === 'string' ? { autoCommand: options } : (options || {});
    const skipDirectoryPrompt = !!resolvedOptions.skipDirectoryPrompt;
    const shouldActivate = resolvedOptions.activate !== false;
    const deferSessionStart = !!resolvedOptions.deferSessionStart;
    const deferAutoRun = !!resolvedOptions.deferAutoRun;
    const autoCommand = resolvedOptions.autoCommand ? normalizeAiCommand(resolvedOptions.autoCommand) : null;
    let cwd = resolvedOptions.cwd || null;
    let dirName = resolvedOptions.title || '终端';

    // Only show directory picker for AI tabs when not restoring.
    if (autoCommand && !skipDirectoryPrompt) {
      const result = await window.api.selectDirectory();
      if (result.canceled) return null;
      cwd = result.path;
      dirName = cwd.split('/').pop() || cwd;
    } else if (autoCommand && cwd && !resolvedOptions.title) {
      dirName = cwd.split('/').pop() || cwd;
    }

    const tabId = generateTabId();
    const tabData = {
      id: tabId,
      title: dirName,
      manuallyRenamed: !!resolvedOptions.manuallyRenamed,
      cwd,
      autoCommand,
      shellMode: String(resolvedOptions.shellMode || '').trim(),
      sessionReady: false,
      sessionState: deferSessionStart ? 'dormant' : 'starting',
      sessionStartPromise: null,
      pendingAutoCommand: deferAutoRun && autoCommand ? autoCommand : '',
      heartbeatStatus: 'unknown',
      heartbeatSummary: '',
      heartbeatAnalysis: '',
      heartbeatAt: ''
    };
    tabs.push(tabData);

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.tabId = tabId;

    const heartbeatDot = document.createElement('span');
    heartbeatDot.className = 'tab-heartbeat-dot status-unknown';
    heartbeatDot.setAttribute('aria-hidden', 'true');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tabData.title;

    const folderSpan = document.createElement('span');
    folderSpan.className = 'tab-folder hidden';

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '\u00d7';

    tabEl.appendChild(heartbeatDot);
    tabEl.appendChild(titleSpan);
    tabEl.appendChild(folderSpan);
    tabEl.appendChild(closeBtn);
    // Insert before both add buttons
    tabBar.insertBefore(tabEl, btnAddTerminal);
    renderTabLabel(tabId);
    renderTabHeartbeat(tabId);

    tabEl.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) {
        switchToTabById(tabId);
      }
    });

    titleSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(tabEl, tabData);
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tabId).catch((closeErr) => {
        console.warn('Failed to close tab:', closeErr);
        showInAppNotice('关闭标签失败', `原因：${formatErrorDetail(closeErr)}`);
      });
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.tabId = tabId;
    terminalContainer.appendChild(wrapper);

    if (shouldActivate) {
      activeTabId = tabId;
      setActiveTabVisual(tabId);
    } else {
      setActiveTabVisual(activeTabId);
    }

    if (!deferSessionStart) {
      await ensureTabSessionReady(tabData, {
        autoRunCommand: !deferAutoRun,
        shellMode: tabData.shellMode,
        runPendingCommand: shouldActivate && !resolvedOptions.deferPendingCommandFlush
      });
    } else if (tabData.pendingAutoCommand) {
      updateTabHeartbeatMeta(tabId, {
        status: 'running',
        summary: '会话待激活',
        analysis: '切换到该标签后将启动终端并继续会话。',
        at: new Date().toISOString()
      });
    }

    if (shouldActivate && tabData.sessionReady) {
      terminalManager.focus(tabId);
    }
    syncScrollBottomButton();
    persistTabSnapshot();
    return tabId;
  } catch (err) {
    console.warn('Unexpected error while creating tab:', err);
    showInAppNotice('新建标签失败', `原因：${formatErrorDetail(err)}`);
    return null;
  }
}

async function createNewAiTab() {
  return createNewTab({ autoCommand: aiCommand });
}

function switchToTabById(tabId) {
  const tabData = getTabDataById(tabId);
  if (!tabData) return;
  activeTabId = tabId;
  setActiveTabVisual(tabId);
  requestAnimationFrame(() => {
    Promise.resolve()
      .then(async () => {
        if (!tabData.sessionReady) {
          const shouldAutoRunAtCreate = !String(tabData.pendingAutoCommand || '').trim();
          await ensureTabSessionReady(tabData, {
            autoRunCommand: shouldAutoRunAtCreate,
            shellMode: tabData.shellMode,
            runPendingCommand: true
          });
        } else {
          await runPendingAutoCommandIfNeeded(tabData);
        }
      })
      .catch((err) => {
        console.warn('Failed to activate tab session:', err);
      })
      .finally(() => {
        if (tabData.sessionReady) {
          terminalManager.focus(tabId);
        }
        syncScrollBottomButton();
      });
  });
  persistTabSnapshot();
}

function switchToTabByIndex(index) {
  if (index >= 0 && index < tabs.length) {
    switchToTabById(tabs[index].id);
  }
}

function switchToPrevTab() {
  debugLog('switchToPrevTab called');
  if (tabs.length === 0) return;
  const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
  const prevIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
  debugLog(`Switching from tab ${currentIndex} to ${prevIndex}`);
  switchToTabById(tabs[prevIndex].id);
}

function switchToNextTab() {
  debugLog('switchToNextTab called');
  if (tabs.length === 0) return;
  const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
  const nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
  debugLog(`Switching from tab ${currentIndex} to ${nextIndex}`);
  switchToTabById(tabs[nextIndex].id);
}

async function confirmCloseTab(tabData) {
  const tabTitle = tabData && tabData.title ? tabData.title : '当前标签页';
  const message = `确定要关闭“${tabTitle}”吗？`;
  const detail = '关闭后此会话将终止，无法恢复。';

  try {
    const result = await window.api.confirmDialog('关闭标签页', message, detail);
    return !!(result && result.confirmed);
  } catch (err) {
    console.warn('Failed to show native confirm dialog, fallback to window.confirm:', err);
    return window.confirm(`${message}\n${detail}`);
  }
}

async function closeTab(tabId) {
  const index = tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return;

  const tabData = tabs[index];
  const shouldClose = await confirmCloseTab(tabData);
  if (!shouldClose) return;

  if (tabs.length === 1) {
    await createNewTab();
    if (tabs.length === 1) return;
  }

  tabs.splice(index, 1);
  pendingTopicRefreshTabs.delete(tabId);
  const tabEl = tabBar.querySelector(`.tab[data-tab-id="${tabId}"]`);
  if (tabEl) tabEl.remove();
  terminalManager.destroy(tabId);
  await window.api.closeTerminal(tabId);

  if (activeTabId === tabId) {
    const newIndex = Math.min(index, tabs.length - 1);
    switchToTabById(tabs[newIndex].id);
  }
  persistTabSnapshot();
}

// --- Tab Rename ---

function startRename(tabEl, tabData) {
  const titleSpan = tabEl.querySelector('.tab-title');
  if (!titleSpan) return;

  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.value = tabData.title;
  titleSpan.replaceWith(input);
  input.select();
  input.focus();

  let finished = false;
  const finishRename = () => {
    if (finished) return;
    finished = true;
    const newTitle = input.value.trim() || tabData.title;
    tabData.title = newTitle;
    tabData.manuallyRenamed = true;
    const newSpan = document.createElement('span');
    newSpan.className = 'tab-title';
    newSpan.textContent = newTitle;
    newSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(tabEl, tabData);
    });
    input.replaceWith(newSpan);
    renderTabLabel(tabData.id, false);
    persistTabSnapshot();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finishRename();
    if (e.key === 'Escape') {
      input.value = tabData.title;
      finishRename();
    }
    e.stopPropagation();
  });
}

// --- Topic Detection ---

async function refreshAllTopics() {
  const targetTabId = String(activeTabId || '').trim();
  if (!targetTabId) {
    showInAppNotice('刷新失败', '当前没有可刷新的会话标签。');
    return;
  }

  const targetTab = tabs.find((tab) => tab.id === targetTabId);
  if (!targetTab) {
    showInAppNotice('刷新失败', '未找到当前会话标签，请重试。');
    return;
  }

  const ready = await ensureTabSessionReady(targetTab, {
    autoRunCommand: !String(targetTab.pendingAutoCommand || '').trim(),
    shellMode: targetTab.shellMode,
    runPendingCommand: true
  });
  if (!ready) {
    showInAppNotice('刷新会话分析失败', '当前会话未就绪，无法刷新标题。');
    return;
  }

  pendingTopicRefreshTabs.add(targetTabId);
  updateTabTitle(targetTabId, '分析中...', true);

  const result = await window.api.refreshTopics({ tabId: targetTabId });
  if (result && Array.isArray(result.results)) {
    const hit = result.results.find((item) => String(item.tabId || '') === targetTabId);
    if (hit && String(hit.topic || '').trim()) {
      updateTabTitle(targetTabId, String(hit.topic).trim(), false);
      pendingTopicRefreshTabs.delete(targetTabId);
      return;
    }
  }

  if (!result || result.success !== true) {
    pendingTopicRefreshTabs.delete(targetTabId);
    const reason = result && result.error ? String(result.error) : '未知错误';
    showInAppNotice('刷新会话分析失败', `原因：${reason}`);
  }
}

function updateTabTitle(tabId, title, analyzing) {
  const tabData = tabs.find((t) => t.id === tabId);
  if (tabData && !analyzing) {
    tabData.title = title;
    persistTabSnapshot();
  }
  renderTabLabel(tabId, !!analyzing);
}

// --- Theme Init ---

// Keep following system preference, but without manual toggle button in UI.
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const isLight = !prefersDark.matches;

function initTheme() {
  document.body.classList.toggle('light', isLight);
  terminalManager.setLightMode(isLight);
}

// --- Settings Modal ---

async function loadRuntimeSettings() {
  try {
    const config = normalizeRuntimeSettings(await window.api.getSettings());
    aiCommand = config.aiCommand;
    applyQuickSettings(config);
    return config;
  } catch (err) {
    console.warn('Failed to load runtime settings:', err);
    const fallback = normalizeRuntimeSettings({
      apiKey: '',
      baseUrl: '',
      aiCommand: 'codex -m gpt-5.3-codex',
      heartbeatEnabled: true,
      heartbeatIntervalMs: 10 * 60 * 1000,
      heartbeatPreferSessionAi: true
    });
    aiCommand = fallback.aiCommand;
    applyQuickSettings(fallback);
    return fallback;
  }
}

async function openSettings() {
  const config = await loadRuntimeSettings();
  settingsAiCommand.value = config.aiCommand;
  settingsBaseUrl.value = config.baseUrl || '';
  settingsApiKey.value = config.apiKey || '';
  settingsModal.classList.remove('hidden');
  settingsAiCommand.focus();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

async function saveSettings() {
  const current = normalizeRuntimeSettings(await window.api.getSettings());
  const nextConfig = normalizeRuntimeSettings({
    ...current,
    apiKey: settingsApiKey.value.trim(),
    baseUrl: settingsBaseUrl.value.trim(),
    aiCommand: settingsAiCommand.value
  });
  await persistRuntimeSettings(nextConfig);
  closeSettings();
  showInAppNotice('设置已保存', '新建会话将使用最新默认命令与连接配置。');
}

async function saveQuickHeartbeatSettings() {
  const nextHeartbeatEnabled = !!quickHeartbeatEnabled.checked;
  const nextHeartbeatIntervalMs = (Number(quickHeartbeatInterval.value) || 10) * 60 * 1000;
  const current = normalizeRuntimeSettings(await window.api.getSettings());
  await persistRuntimeSettings({
    ...current,
    heartbeatEnabled: nextHeartbeatEnabled,
    heartbeatIntervalMs: nextHeartbeatIntervalMs
  });
}

function initializeQuickSettings() {
  if (!quickHeartbeatEnabled || !quickHeartbeatInterval) return;

  quickHeartbeatEnabled.addEventListener('change', async () => {
    try {
      await saveQuickHeartbeatSettings();
      showInAppNotice('心跳已更新', `会话心跳${quickHeartbeatEnabled.checked ? '已启用' : '已关闭'}。`);
    } catch (err) {
      console.warn('Failed to update heartbeat enabled flag:', err);
      showInAppNotice('心跳更新失败', '请稍后再试或在设置中手动修改。');
    }
  });

  quickHeartbeatInterval.addEventListener('change', async () => {
    try {
      await saveQuickHeartbeatSettings();
      showInAppNotice('心跳已更新', `心跳间隔已调整为 ${quickHeartbeatInterval.value} 分钟。`);
    } catch (err) {
      console.warn('Failed to update heartbeat interval:', err);
      showInAppNotice('心跳更新失败', '请稍后再试或在设置中手动修改。');
    }
  });
}

function ensureInAppNoticeContainer() {
  if (inAppNoticeContainer && document.body.contains(inAppNoticeContainer)) {
    return inAppNoticeContainer;
  }

  inAppNoticeContainer = document.createElement('div');
  inAppNoticeContainer.id = 'notice-stack';
  document.body.appendChild(inAppNoticeContainer);
  return inAppNoticeContainer;
}

function showInAppNotice(title, message) {
  const container = ensureInAppNoticeContainer();
  const notice = document.createElement('div');
  notice.className = 'notice-card';

  const titleEl = document.createElement('div');
  titleEl.className = 'notice-title';
  titleEl.textContent = title;

  const messageEl = document.createElement('div');
  messageEl.className = 'notice-message';
  messageEl.textContent = message;

  notice.appendChild(titleEl);
  notice.appendChild(messageEl);
  container.appendChild(notice);

  requestAnimationFrame(() => {
    notice.classList.add('visible');
  });

  setTimeout(() => {
    notice.classList.remove('visible');
    setTimeout(() => {
      notice.remove();
    }, 220);
  }, 5200);
}

function validateApiBridge() {
  const requiredMethods = [
    'createTerminal',
    'sendTerminalData',
    'resizeTerminal',
    'closeTerminal',
    'getSettings',
    'saveSettings',
    'getTabSnapshot',
    'saveTabSnapshot'
  ];
  const missing = requiredMethods.filter((methodName) => !hasApiMethod(methodName));
  if (missing.length === 0) return;

  const preview = missing.slice(0, 4).join(', ');
  const suffix = missing.length > 4 ? ` 等 ${missing.length} 项` : '';
  showInAppNotice(
    '运行环境异常',
    `应用桥接接口缺失（${preview}${suffix}），请重新安装最新版本。`
  );
}

function validateTerminalRuntime() {
  if (!terminalManager || !terminalManager.__isFallback) return;
  showInAppNotice(
    '终端组件异常',
    '终端渲染组件未正常加载。请重新安装最新版应用后重试。'
  );
}

function validateUiRuntime() {
  const missing = UI_REQUIRED_ELEMENTS
    .filter(([, element]) => !element)
    .map(([id]) => id);
  if (missing.length === 0) return;

  showInAppNotice(
    '界面组件异常',
    `缺少必要界面元素：${missing.join(', ')}。请重新安装最新版应用。`
  );
}

function reportAsyncFailure(title, err, fallbackMessage) {
  console.warn(`${title}:`, err);
  const message = fallbackMessage || `原因：${formatErrorDetail(err)}`;
  showInAppNotice(title, message);
}

function runAsyncSafely(action, title, fallbackMessage) {
  return (...args) => {
    Promise.resolve()
      .then(() => action(...args))
      .catch((err) => reportAsyncFailure(title, err, fallbackMessage));
  };
}

function bindClickSafely(element, handler, missingLabel) {
  if (!element) {
    console.warn(`[ui] Missing clickable element: ${missingLabel}`);
    return false;
  }
  element.addEventListener('click', handler);
  return true;
}

function registerGlobalRuntimeNoticeHandlers() {
  if (window.__shaotermGlobalRuntimeNoticeHandlersInstalled) return;
  window.__shaotermGlobalRuntimeNoticeHandlersInstalled = true;

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason ? event.reason : new Error('未知异步异常');
    reportAsyncFailure('运行异常', reason, '发生未处理的异步错误，请重试刚才的操作。');
  });
}

registerGlobalRuntimeNoticeHandlers();

async function showNonBlockingNotice(title, message) {
  try {
    const result = await window.api.notifyInfo(title, message);
    if (result && result.shown) {
      return;
    }
  } catch (err) {
    console.warn('System notification unavailable, falling back to in-app notice:', err);
  }

  showInAppNotice(title, message);
}

async function showHeartbeatArchiveDigestForActiveTab() {
  if (!activeTabId) {
    showInAppNotice('心跳归档', '当前没有可提取归档的活跃会话。');
    return;
  }

  const tabData = tabs.find((t) => t.id === activeTabId);
  const tabTitle = tabData && tabData.title ? tabData.title : '当前会话';

  try {
    const result = await window.api.summarizeHeartbeatArchive({
      tabId: activeTabId,
      days: 14,
      limit: 30
    });

    const hasRecords = !!(result && Array.isArray(result.records) && result.records.length > 0);
    const hasLiveSnapshot = !!(result && result.liveSnapshot);
    if (!hasRecords && !hasLiveSnapshot) {
      showInAppNotice('心跳归档', `会话“${tabTitle}”暂无可用归档记录。`);
      return;
    }

    const summary = (result.summary || '已提取会话归档摘要').replace(/\s+/g, ' ').trim();
    const analysis = (result.analysis || '').replace(/\s+/g, ' ').trim();
    const stats = hasRecords
      ? `提取 ${result.records.length}/${result.total} 条记录`
      : '基于当前会话输出即时总结';
    const message = analysis ? `${summary}\n${analysis}\n${stats}` : `${summary}\n${stats}`;
    showNonBlockingNotice(`归档总结 · ${tabTitle}`, message);
  } catch (err) {
    console.warn('Failed to summarize heartbeat archive:', err);
    showInAppNotice('心跳归档提取失败', '请稍后重试。');
  }
}

// --- IPC Listeners ---

registerApiListener('onTerminalOutput', ({ tabId, data }) => {
  terminalManager.write(tabId, data);
});

registerApiListener('onTerminalClosed', ({ tabId }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  if (tabData) {
    updateTabHeartbeatMeta(tabId, {
      status: 'ended',
      summary: '会话已结束',
      analysis: '',
      at: new Date().toISOString()
    });
    updateTabTitle(tabId, tabData.title + ' (ended)', false);
  }
});

registerApiListener('onTerminalHeartbeatSummary', ({ tabId, summary, analysis, status, at }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  const tabTitle = tabData && tabData.title ? tabData.title : '当前会话';
  const compactSummary = (summary || '会话进行中').replace(/\s+/g, ' ').trim();
  const compactAnalysis = (analysis || '').replace(/\s+/g, ' ').trim();
  updateTabHeartbeatMeta(tabId, {
    status,
    summary: compactSummary,
    analysis: compactAnalysis,
    at
  });
  debugLog(`[heartbeat][silent] ${tabTitle}: ${compactSummary}${compactAnalysis ? ` | ${compactAnalysis}` : ''}`);
});

registerApiListener('onTerminalSessionProfile', ({ tabId, autoCommand, source }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  if (!tabData) return;
  syncTabAutoCommand(tabData, autoCommand, source || 'session_profile');
});

registerApiListener('onTerminalConfirmNeeded', ({ tabId, prompt }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  if (!tabData) return;

  const compactPrompt = (prompt || '').replace(/\s+/g, ' ').trim();
  updateTabHeartbeatMeta(tabId, {
    status: 'waiting',
    summary: compactPrompt ? '检测到确认提示' : '会话等待输入',
    analysis: compactPrompt || '请查看该会话最新输出并决定下一步。',
    at: new Date().toISOString()
  });
  debugLog(`[heartbeat][confirm-signal] ${tabData.title}: ${compactPrompt || 'waiting for input'}`);
});

registerApiListener('onTopicStatus', ({ tabId, status, topic }) => {
  const normalizedTabId = String(tabId || '').trim();
  if (!normalizedTabId) return;

  const tabData = tabs.find((t) => t.id === normalizedTabId);
  if (!tabData) return;

  const requestedByUser = pendingTopicRefreshTabs.has(normalizedTabId);
  if (status === 'done' && (requestedByUser || !tabData.manuallyRenamed)) {
    updateTabTitle(normalizedTabId, topic, false);
  } else {
    renderTabLabel(normalizedTabId, false);
  }

  pendingTopicRefreshTabs.delete(normalizedTabId);
});

// Handle file drops from main process
registerApiListener('onFileDrop', ({ paths }) => {
  debugLog('File drop from main process:', paths);
  if (activeTabId && paths && paths.length > 0) {
    const quotedPaths = paths.map(p => p.includes(' ') ? `"${p}"` : p);
    const pathString = quotedPaths.join(' ');
    debugLog('Sending file paths to terminal:', pathString);
    window.api.sendTerminalData(activeTabId, pathString);
  }
});

// --- Shortcut Listeners ---

debugLog('Setting up shortcut listeners...');

registerApiListener('onNewTab', runAsyncSafely(
  () => createNewAiTab(),
  '新建会话失败'
));
registerApiListener('onCloseTab', runAsyncSafely(
  () => {
    if (activeTabId) {
      return closeTab(activeTabId);
    }
    return null;
  },
  '关闭会话失败'
));
registerApiListener('onRefreshTopics', runAsyncSafely(
  () => refreshAllTopics(),
  '刷新会话分析失败'
));
registerApiListener('onShowHeartbeatArchive', runAsyncSafely(
  () => showHeartbeatArchiveDigestForActiveTab(),
  '提取心跳归档失败'
));
registerApiListener('onSwitchTab', ({ index }) => switchToTabByIndex(index));
registerApiListener('onIncreaseFont', () => {
  debugLog('onIncreaseFont shortcut triggered');
  terminalManager.increaseFontSize();
});
registerApiListener('onDecreaseFont', () => {
  debugLog('onDecreaseFont shortcut triggered');
  terminalManager.decreaseFontSize();
});
registerApiListener('onResetFont', () => {
  debugLog('onResetFont shortcut triggered');
  terminalManager.resetFontSize();
});
registerApiListener('onPrevTab', () => {
  debugLog('onPrevTab shortcut triggered');
  switchToPrevTab();
});
registerApiListener('onNextTab', () => {
  debugLog('onNextTab shortcut triggered');
  switchToNextTab();
});

debugLog('Shortcut listeners set up complete');

// --- Button Listeners ---

bindClickSafely(btnAddTerminal, runAsyncSafely(
  () => createNewTab(),
  '新建标签失败'
), 'btn-add-terminal');
bindClickSafely(btnAddAi, runAsyncSafely(
  () => createNewAiTab(),
  '新建 AI 会话失败'
), 'btn-add-ai');
bindClickSafely(btnSettings, runAsyncSafely(
  () => openSettings(),
  '打开设置失败'
), 'btn-settings');
bindClickSafely(btnSettingsSave, runAsyncSafely(
  () => saveSettings(),
  '保存设置失败'
), 'btn-settings-save');
bindClickSafely(btnSettingsCancel, () => closeSettings(), 'btn-settings-cancel');
bindClickSafely(btnScrollBottom, () => {
  debugLog('Scroll to bottom clicked');
  if (activeTabId) {
    terminalManager.ensureInputVisible(activeTabId);
    btnScrollBottom.classList.remove('visible');
  }
}, 'btn-scroll-bottom');

if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });
} else {
  console.warn('[ui] Missing settings modal element.');
}

terminalManager.onScrollStateChange(handleTerminalScrollStateChange);

// --- Init ---

// Initialize theme based on system preference
initTheme();
initializeQuickSettings();
validateApiBridge();
validateTerminalRuntime();
validateUiRuntime();
window.addEventListener('beforeunload', () => {
  persistTabSnapshot({ immediate: true });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistTabSnapshot({ immediate: true });
  }
});

async function bootstrapApp() {
  await loadRuntimeSettings();
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, STARTUP_PHASE_DELAY_MS)));

  const restored = await restoreTabsFromSnapshot();
  if (restored) return;

  const aiTabId = await createNewAiTab();
  if (aiTabId) return;

  const terminalTabId = await createNewTab();
  if (!terminalTabId) {
    showInAppNotice('会话初始化失败', '请点击“+”或“AI+”重新创建会话。');
  }
}

bootstrapApp().catch((err) => {
  reportAsyncFailure('应用初始化失败', err, '初始化会话时出现异常，请尝试手动新建标签。');
});

})();
