/* global TerminalManager */

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

const terminalManager = new TerminalManager();
const tabs = []; // { id, title, manuallyRenamed, cwd, autoCommand, heartbeatStatus, heartbeatSummary, heartbeatAnalysis, heartbeatAt }
let activeTabId = null;
let inAppNoticeContainer = null;
const TAB_SNAPSHOT_KEY = 'shaoterm.tab-snapshot.v1';
let isRestoringTabs = false;

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
let aiCommand = 'codex';
const HEARTBEAT_INTERVAL_OPTIONS = ['5', '10', '15', '30'];
const TERMINAL_BOTTOM_SNAP_LINES = 2;
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
  const lines = [];
  lines.push(`心跳：${status}${at ? ` · ${at}` : ''}`);
  if (summary) lines.push(`总结：${summary}`);
  if (analysis) lines.push(`分析：${analysis}`);
  return lines.join('\n');
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
    heartbeatPreferSessionAi: false
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

function createTabSnapshot() {
  return {
    version: 1,
    activeIndex: tabs.findIndex((tab) => tab.id === activeTabId),
    tabs: tabs.map((tab) => ({
      title: tab.title,
      manuallyRenamed: !!tab.manuallyRenamed,
      cwd: tab.cwd || '',
      autoCommand: tab.autoCommand || ''
    }))
  };
}

function persistTabSnapshot() {
  if (isRestoringTabs) return;
  try {
    window.localStorage.setItem(TAB_SNAPSHOT_KEY, JSON.stringify(createTabSnapshot()));
  } catch (err) {
    console.warn('Failed to persist tab snapshot:', err);
  }
}

function loadTabSnapshot() {
  try {
    const raw = window.localStorage.getItem(TAB_SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) return null;
    return snapshot;
  } catch (err) {
    console.warn('Failed to load tab snapshot:', err);
    return null;
  }
}

async function restoreTabsFromSnapshot() {
  const snapshot = loadTabSnapshot();
  if (!snapshot) return false;

  isRestoringTabs = true;
  let restoredCount = 0;

  try {
    for (const tab of snapshot.tabs) {
      try {
        const restoredId = await createNewTab({
          title: tab.title || '终端',
          manuallyRenamed: !!tab.manuallyRenamed,
          cwd: tab.cwd || null,
          autoCommand: tab.autoCommand || null,
          skipDirectoryPrompt: true
        });

        if (restoredId) {
          restoredCount += 1;
        }
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

  const activeIndex = Number(snapshot.activeIndex);
  if (Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < tabs.length) {
    switchToTabById(tabs[activeIndex].id);
  } else if (tabs.length > 0) {
    switchToTabById(tabs[tabs.length - 1].id);
  }

  persistTabSnapshot();
  return true;
}

async function createNewTab(options = {}) {
  const resolvedOptions = typeof options === 'string' ? { autoCommand: options } : (options || {});
  const skipDirectoryPrompt = !!resolvedOptions.skipDirectoryPrompt;
  const autoCommand = resolvedOptions.autoCommand ? normalizeAiCommand(resolvedOptions.autoCommand) : null;
  const previousActiveTabId = activeTabId;
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

  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';

  tabEl.appendChild(heartbeatDot);
  tabEl.appendChild(titleSpan);
  tabEl.appendChild(closeBtn);
  // Insert before both add buttons
  tabBar.insertBefore(tabEl, btnAddTerminal);
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
    closeTab(tabId);
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.tabId = tabId;
  terminalContainer.appendChild(wrapper);

  // Make visible before creating xterm
  activeTabId = tabId;
  tabBar.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });
  terminalContainer.querySelectorAll('.terminal-wrapper').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });

  const { cols, rows } = terminalManager.create(tabId, wrapper);
  let createResult = null;
  try {
    createResult = await window.api.createTerminal(tabId, cwd, autoCommand || null);
  } catch (err) {
    console.warn('Failed to create terminal session:', err);
    terminalManager.destroy(tabId);
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex >= 0) tabs.splice(tabIndex, 1);
    const staleTabEl = tabBar.querySelector(`.tab[data-tab-id="${tabId}"]`);
    if (staleTabEl) staleTabEl.remove();
    activeTabId = previousActiveTabId && tabs.some((t) => t.id === previousActiveTabId)
      ? previousActiveTabId
      : (tabs[0] ? tabs[0].id : null);
    if (activeTabId) {
      switchToTabById(activeTabId);
    } else {
      syncScrollBottomButton();
    }
    showInAppNotice('会话创建失败', '无法创建终端会话，请检查 shell 环境后重试。');
    return null;
  }
  if (createResult && createResult.resolvedCwd) {
    tabData.cwd = createResult.resolvedCwd;
  }
  if (createResult && createResult.cwdFallbackApplied) {
    const requestedPath = String(createResult.requestedCwd || '').trim();
    const fallbackPath = String(createResult.resolvedCwd || '').trim();
    const fallbackMessage = requestedPath
      ? `目录不可用，已自动切换到：${fallbackPath}`
      : `未提供目录，已使用默认目录：${fallbackPath}`;
    showInAppNotice('目录已自动回退', fallbackMessage);
  }
  updateTabHeartbeatMeta(tabId, {
    status: 'running',
    summary: '会话已启动',
    analysis: tabData.cwd ? `工作目录：${tabData.cwd}` : '',
    at: new Date().toISOString()
  });
  window.api.resizeTerminal(tabId, cols, rows);
  terminalManager.focus(tabId);
  syncScrollBottomButton();
  persistTabSnapshot();
  return tabId;
}

async function createNewAiTab() {
  await createNewTab({ autoCommand: aiCommand });
}

function switchToTabById(tabId) {
  if (!tabs.some((tab) => tab.id === tabId)) return;
  activeTabId = tabId;
  tabBar.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });
  terminalContainer.querySelectorAll('.terminal-wrapper').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });
  requestAnimationFrame(() => {
    terminalManager.focus(tabId);
    syncScrollBottomButton();
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
  tabs.forEach((tabData) => {
    if (!tabData.manuallyRenamed) {
      updateTabTitle(tabData.id, '分析中...', true);
    }
  });
  await window.api.refreshTopics();
}

function updateTabTitle(tabId, title, analyzing) {
  const tabData = tabs.find((t) => t.id === tabId);
  if (tabData && !analyzing) {
    tabData.title = title;
    persistTabSnapshot();
  }
  const tabEl = tabBar.querySelector(`.tab[data-tab-id="${tabId}"]`);
  if (tabEl) {
    const titleSpan = tabEl.querySelector('.tab-title');
    if (titleSpan) {
      titleSpan.textContent = title;
      titleSpan.classList.toggle('analyzing', !!analyzing);
    }
  }
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
      heartbeatPreferSessionAi: false
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

    if (!result || !Array.isArray(result.records) || result.records.length === 0) {
      showInAppNotice('心跳归档', `会话“${tabTitle}”暂无可用归档记录。`);
      return;
    }

    const summary = (result.summary || '已提取会话归档摘要').replace(/\s+/g, ' ').trim();
    const analysis = (result.analysis || '').replace(/\s+/g, ' ').trim();
    const stats = `提取 ${result.records.length}/${result.total} 条记录`;
    const message = analysis ? `${summary}\n${analysis}\n${stats}` : `${summary}\n${stats}`;
    showNonBlockingNotice(`归档总结 · ${tabTitle}`, message);
  } catch (err) {
    console.warn('Failed to summarize heartbeat archive:', err);
    showInAppNotice('心跳归档提取失败', '请稍后重试。');
  }
}

// --- IPC Listeners ---

window.api.onTerminalOutput(({ tabId, data }) => {
  terminalManager.write(tabId, data);
});

window.api.onTerminalClosed(({ tabId }) => {
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

window.api.onTerminalHeartbeatSummary(({ tabId, summary, analysis, status, at }) => {
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

window.api.onTerminalConfirmNeeded(({ tabId, prompt }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  if (!tabData) return;

  const compactPrompt = (prompt || '').replace(/\s+/g, ' ').trim();
  updateTabHeartbeatMeta(tabId, {
    status: 'waiting',
    summary: compactPrompt ? '检测到确认提示' : '会话等待输入',
    analysis: compactPrompt || '请查看该会话最新输出并决定下一步。',
    at: new Date().toISOString()
  });
  const message = compactPrompt
    ? `会话“${tabData.title}”需要确认：${compactPrompt}`
    : `会话“${tabData.title}”检测到确认信息，请查看最新输出。`;

  showNonBlockingNotice('需要确认', message);
});

window.api.onTopicStatus(({ tabId, status, topic }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  if (tabData && !tabData.manuallyRenamed) {
    updateTabTitle(tabId, topic, false);
  }
});

// Handle file drops from main process
window.api.onFileDrop(({ paths }) => {
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

window.api.onNewTab(() => createNewAiTab());
window.api.onCloseTab(() => { if (activeTabId) closeTab(activeTabId); });
window.api.onRefreshTopics(() => refreshAllTopics());
window.api.onShowHeartbeatArchive(() => showHeartbeatArchiveDigestForActiveTab());
window.api.onSwitchTab(({ index }) => switchToTabByIndex(index));
window.api.onIncreaseFont(() => {
  debugLog('onIncreaseFont shortcut triggered');
  terminalManager.increaseFontSize();
});
window.api.onDecreaseFont(() => {
  debugLog('onDecreaseFont shortcut triggered');
  terminalManager.decreaseFontSize();
});
window.api.onResetFont(() => {
  debugLog('onResetFont shortcut triggered');
  terminalManager.resetFontSize();
});
window.api.onPrevTab(() => {
  debugLog('onPrevTab shortcut triggered');
  switchToPrevTab();
});
window.api.onNextTab(() => {
  debugLog('onNextTab shortcut triggered');
  switchToNextTab();
});

debugLog('Shortcut listeners set up complete');

// --- Button Listeners ---

btnAddTerminal.addEventListener('click', () => createNewTab());
btnAddAi.addEventListener('click', () => createNewAiTab());
btnSettings.addEventListener('click', () => openSettings());
btnSettingsSave.addEventListener('click', () => saveSettings());
btnSettingsCancel.addEventListener('click', () => closeSettings());
btnScrollBottom.addEventListener('click', () => {
  debugLog('Scroll to bottom clicked');
  if (activeTabId) {
    terminalManager.ensureInputVisible(activeTabId);
    btnScrollBottom.classList.remove('visible');
  }
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

terminalManager.onScrollStateChange(handleTerminalScrollStateChange);

// --- Init ---

// Initialize theme based on system preference
initTheme();
initializeQuickSettings();
window.addEventListener('beforeunload', persistTabSnapshot);

async function bootstrapApp() {
  await loadRuntimeSettings();
  const restored = await restoreTabsFromSnapshot();
  if (!restored) {
    await createNewAiTab();
  }
}

bootstrapApp();
