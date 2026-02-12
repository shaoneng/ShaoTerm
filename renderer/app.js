/* global TerminalManager */

// --- Debug Logging System ---
const debugLogs = [];
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info
};

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

// Override console methods
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

// --- App State ---

const terminalManager = new TerminalManager();
const tabs = []; // { id, title, manuallyRenamed }
let activeTabId = null;
let inAppNoticeContainer = null;

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
let aiCommand = 'codex';

// --- Tab Management ---

function generateTabId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 6);
}

function normalizeAiCommand(value) {
  const normalized = (value || '').trim();
  return normalized || 'codex';
}

async function createNewTab(autoCommand) {
  let cwd = null;
  let dirName = '终端';

  // Only show directory picker for AI tabs
  if (autoCommand) {
    const result = await window.api.selectDirectory();
    if (result.canceled) return;
    cwd = result.path;
    dirName = cwd.split('/').pop() || cwd;
  }

  const tabId = generateTabId();
  const tabData = { id: tabId, title: dirName, manuallyRenamed: false };
  tabs.push(tabData);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = tabId;

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = tabData.title;

  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';

  tabEl.appendChild(titleSpan);
  tabEl.appendChild(closeBtn);
  // Insert before both add buttons
  tabBar.insertBefore(tabEl, btnAddTerminal);

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

  await window.api.createTerminal(tabId, cwd, autoCommand || null);
  window.api.resizeTerminal(tabId, cols, rows);
  terminalManager.focus(tabId);
}

async function createNewAiTab() {
  await createNewTab(aiCommand);
}

function switchToTabById(tabId) {
  activeTabId = tabId;
  tabBar.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });
  terminalContainer.querySelectorAll('.terminal-wrapper').forEach((el) => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });
  requestAnimationFrame(() => {
    terminalManager.focus(tabId);
  });
}

function switchToTabByIndex(index) {
  if (index >= 0 && index < tabs.length) {
    switchToTabById(tabs[index].id);
  }
}

function switchToPrevTab() {
  console.log('switchToPrevTab called');
  if (tabs.length === 0) return;
  const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
  const prevIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
  console.log(`Switching from tab ${currentIndex} to ${prevIndex}`);
  switchToTabById(tabs[prevIndex].id);
}

function switchToNextTab() {
  console.log('switchToNextTab called');
  if (tabs.length === 0) return;
  const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
  const nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
  console.log(`Switching from tab ${currentIndex} to ${nextIndex}`);
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
    const config = await window.api.getSettings();
    aiCommand = normalizeAiCommand(config.aiCommand);
    return config;
  } catch (err) {
    console.warn('Failed to load runtime settings:', err);
    aiCommand = 'codex';
    return { apiKey: '', baseUrl: '', aiCommand };
  }
}

async function openSettings() {
  const config = await loadRuntimeSettings();
  settingsAiCommand.value = normalizeAiCommand(config.aiCommand);
  settingsBaseUrl.value = config.baseUrl || '';
  settingsApiKey.value = config.apiKey || '';
  settingsModal.classList.remove('hidden');
  settingsAiCommand.focus();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

async function saveSettings() {
  const command = normalizeAiCommand(settingsAiCommand.value);
  const baseUrl = settingsBaseUrl.value.trim();
  const apiKey = settingsApiKey.value.trim();
  aiCommand = command;
  await window.api.saveSettings(apiKey, baseUrl, command);
  closeSettings();
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

// --- IPC Listeners ---

window.api.onTerminalOutput(({ tabId, data }) => {
  terminalManager.write(tabId, data);
});

window.api.onTerminalClosed(({ tabId }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  if (tabData) {
    updateTabTitle(tabId, tabData.title + ' (ended)', false);
  }
});

window.api.onTerminalConfirmNeeded(({ tabId, prompt }) => {
  const tabData = tabs.find((t) => t.id === tabId);
  if (!tabData) return;

  const compactPrompt = (prompt || '').replace(/\s+/g, ' ').trim();
  const message = compactPrompt
    ? `会话“${tabData.title}”需要确认：${compactPrompt}`
    : `会话“${tabData.title}”需要确认，请切换到该会话输入 y/yes 等选项。`;

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
  console.log('File drop from main process:', paths);
  if (activeTabId && paths && paths.length > 0) {
    const quotedPaths = paths.map(p => p.includes(' ') ? `"${p}"` : p);
    const pathString = quotedPaths.join(' ');
    console.log('Sending file paths to terminal:', pathString);
    window.api.sendTerminalData(activeTabId, pathString);
  }
});

// --- Shortcut Listeners ---

console.log('Setting up shortcut listeners...');

window.api.onNewTab(() => createNewAiTab());
window.api.onCloseTab(() => { if (activeTabId) closeTab(activeTabId); });
window.api.onRefreshTopics(() => refreshAllTopics());
window.api.onSwitchTab(({ index }) => switchToTabByIndex(index));
window.api.onIncreaseFont(() => {
  console.log('onIncreaseFont shortcut triggered');
  terminalManager.increaseFontSize();
});
window.api.onDecreaseFont(() => {
  console.log('onDecreaseFont shortcut triggered');
  terminalManager.decreaseFontSize();
});
window.api.onResetFont(() => {
  console.log('onResetFont shortcut triggered');
  terminalManager.resetFontSize();
});
window.api.onPrevTab(() => {
  console.log('onPrevTab shortcut triggered');
  switchToPrevTab();
});
window.api.onNextTab(() => {
  console.log('onNextTab shortcut triggered');
  switchToNextTab();
});

console.log('Shortcut listeners set up complete');

// --- Button Listeners ---

btnAddTerminal.addEventListener('click', () => createNewTab());
btnAddAi.addEventListener('click', () => createNewAiTab());
btnSettings.addEventListener('click', () => openSettings());
btnSettingsSave.addEventListener('click', () => saveSettings());
btnSettingsCancel.addEventListener('click', () => closeSettings());
btnScrollBottom.addEventListener('click', () => {
  console.log('Scroll to bottom clicked');
  if (activeTabId) {
    terminalManager.scrollToBottom(activeTabId);
    btnScrollBottom.classList.remove('visible');
  }
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

// Auto-show scroll button when terminal has scrollback
// Check periodically if terminal is scrolled up
setInterval(() => {
  if (activeTabId) {
    const instance = terminalManager.instances.get(activeTabId);
    if (instance && instance.terminal) {
      const terminal = instance.terminal;
      // Check if terminal is scrolled up (not at bottom)
      const isAtBottom = terminal.buffer.active.viewportY === terminal.buffer.active.baseY;
      if (!isAtBottom) {
        btnScrollBottom.classList.add('visible');
      } else {
        btnScrollBottom.classList.remove('visible');
      }
    }
  }
}, 500); // Check every 500ms

// --- Init ---

// Initialize theme based on system preference
initTheme();

loadRuntimeSettings().finally(() => createNewAiTab());
