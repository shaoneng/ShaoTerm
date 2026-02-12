const { app, BrowserWindow, ipcMain, Menu, dialog, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const topicDetector = require('./lib/topic-detector');

let win;
const terminals = new Map();
const confirmAlertAt = new Map();
const CONFIRM_ALERT_COOLDOWN_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;
const HEARTBEAT_MIN_CHARS = 120;
const HEARTBEAT_CONTEXT_TAIL_CHARS = 2600;
const HEARTBEAT_IDLE_GAP_MS = 12000;
const HEARTBEAT_SESSION_TIMEOUT_MS = 25000;
const HEARTBEAT_SUMMARY_TAG = 'HEARTBEAT_SUMMARY';
const HEARTBEAT_ANALYSIS_TAG = 'HEARTBEAT_ANALYSIS';

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

function parseSessionHeartbeat(rawText) {
  const text = (rawText || '').replace(/\r/g, '\n');
  const summaryMatch = text.match(new RegExp(`${HEARTBEAT_SUMMARY_TAG}\\s*[:：]\\s*(.+)`, 'i'));
  const analysisMatch = text.match(new RegExp(`${HEARTBEAT_ANALYSIS_TAG}\\s*[:：]\\s*(.+)`, 'i'));
  if (!summaryMatch || !analysisMatch) return null;

  const summary = String(summaryMatch[1] || '').trim().slice(0, 120);
  const analysis = String(analysisMatch[1] || '').trim().slice(0, 200);
  if (!summary || !analysis) return null;
  return { summary, analysis };
}

function resolveHeartbeatCollector(entry, report) {
  if (!entry || !entry.heartbeatCollector) return;
  const collector = entry.heartbeatCollector;
  clearTimeout(collector.timeoutId);
  entry.heartbeatCollector = null;
  collector.resolve(report || null);
}

async function requestHeartbeatFromSession(entry) {
  if (!entry || !entry.isAiSession || !entry.alive) return null;

  const prompt = [
    '请基于当前会话上下文做一次心跳总结，只输出两行：',
    `1) ${HEARTBEAT_SUMMARY_TAG}: <不超过30字的一句话总结>`,
    `2) ${HEARTBEAT_ANALYSIS_TAG}: <不超过60字的下一步建议>`,
    '不要输出其他内容。'
  ].join(' ');

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      resolveHeartbeatCollector(entry, null);
    }, HEARTBEAT_SESSION_TIMEOUT_MS);

    entry.heartbeatCollector = {
      raw: '',
      resolve,
      timeoutId
    };
    entry.pty.write(`${prompt}\r`);
  });
}

async function runHeartbeat(tabId, entry) {
  if (!entry || !entry.alive || entry.heartbeatInFlight) return;
  if (entry.activitySeq <= entry.lastHeartbeatActivitySeq) return;

  const now = Date.now();
  const lastActivityAt = Math.max(entry.lastOutputAt || 0, entry.lastUserInputAt || 0);
  if (lastActivityAt > 0 && now - lastActivityAt < HEARTBEAT_IDLE_GAP_MS) return;

  const signature = createHeartbeatSignature(entry.buffer);
  if (signature.length < HEARTBEAT_MIN_CHARS) return;

  entry.heartbeatInFlight = true;
  try {
    const activityMark = entry.activitySeq;
    let report = null;
    let source = 'fallback';

    if (entry.isAiSession) {
      report = await requestHeartbeatFromSession(entry);
      if (report) {
        source = 'session-ai';
      }
    }

    if (!report) {
      report = await topicDetector.analyzeHeartbeat(signature);
    }

    entry.lastHeartbeatSignature = signature;
    entry.lastHeartbeatActivitySeq = activityMark;

    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:heartbeat-summary', {
        tabId,
        summary: report.summary || '会话进行中',
        analysis: report.analysis || '请继续查看最新输出。',
        source,
        at: new Date().toISOString()
      });
    }
  } catch (err) {
    console.warn(`[heartbeat] Failed for tab ${tabId}:`, err.message);
  } finally {
    resolveHeartbeatCollector(entry, null);
    entry.heartbeatInFlight = false;
  }
}

function stopHeartbeat(entry) {
  if (!entry) return;
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }
  resolveHeartbeatCollector(entry, null);
  entry.heartbeatInFlight = false;
}

function startHeartbeat(tabId, entry) {
  stopHeartbeat(entry);
  entry.heartbeatTimer = setInterval(() => {
    runHeartbeat(tabId, entry).catch((err) => {
      console.warn(`[heartbeat] Unexpected error for tab ${tabId}:`, err.message);
    });
  }, HEARTBEAT_INTERVAL_MS);
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
  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' }
  });

  const entry = {
    pty: ptyProcess,
    buffer: '',
    alive: true,
    isAiSession: !!autoCommand,
    activitySeq: 0,
    lastHeartbeatActivitySeq: -1,
    lastOutputAt: Date.now(),
    lastUserInputAt: 0,
    heartbeatInFlight: false,
    heartbeatTimer: null,
    heartbeatCollector: null,
    lastHeartbeatSignature: ''
  };
  terminals.set(tabId, entry);
  startHeartbeat(tabId, entry);

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
    if (entry.heartbeatInFlight && entry.heartbeatCollector) {
      entry.heartbeatCollector.raw += plain;
      if (entry.heartbeatCollector.raw.length > 6000) {
        entry.heartbeatCollector.raw = entry.heartbeatCollector.raw.slice(-6000);
      }
      const parsed = parseSessionHeartbeat(entry.heartbeatCollector.raw);
      if (parsed) {
        resolveHeartbeatCollector(entry, parsed);
      }
    } else if (plain.trim()) {
      entry.activitySeq += 1;
      entry.lastOutputAt = Date.now();
    }

    if (shouldNotifyConfirmPrompt(tabId, plain) && win && !win.isDestroyed()) {
      win.webContents.send('terminal:confirm-needed', {
        tabId,
        prompt: plain.slice(-160).trim()
      });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    entry.alive = false;
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
    if (!entry.heartbeatInFlight && (data || '').trim()) {
      entry.activitySeq += 1;
      entry.lastUserInputAt = Date.now();
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
  return topicDetector.getConfig();
});

ipcMain.handle('settings:save', (event, { apiKey, baseUrl, aiCommand }) => {
  topicDetector.configure(apiKey, baseUrl, aiCommand);
  return { success: true };
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
  createWindow();
});

app.on('window-all-closed', () => {
  for (const [, entry] of terminals) {
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
