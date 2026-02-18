const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Directory picker
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  confirmDialog: (title, message, detail) => ipcRenderer.invoke('dialog:confirm', { title, message, detail }),
  notifyInfo: (title, body) => ipcRenderer.invoke('notify:info', { title, body }),

  // Terminal operations
  createTerminal: (tabId, cwd, autoCommand, options) => ipcRenderer.invoke('terminal:create', { tabId, cwd, autoCommand, options: options || {} }),
  sendTerminalData: (tabId, data) => ipcRenderer.send('terminal:data', { tabId, data }),
  resizeTerminal: (tabId, cols, rows) => ipcRenderer.send('terminal:resize', { tabId, cols, rows }),
  closeTerminal: (tabId) => ipcRenderer.invoke('terminal:close', { tabId }),

  // File drop support
  onFileDrop: (callback) => {
    ipcRenderer.on('file:drop', (event, payload) => callback(payload));
  },

  // Terminal output (main -> renderer)
  onTerminalOutput: (callback) => {
    ipcRenderer.on('terminal:output', (event, payload) => callback(payload));
  },
  onTerminalClosed: (callback) => {
    ipcRenderer.on('terminal:closed', (event, payload) => callback(payload));
  },
  onTerminalHeartbeatSummary: (callback) => {
    ipcRenderer.on('terminal:heartbeat-summary', (event, payload) => callback(payload));
  },
  onTerminalSessionProfile: (callback) => {
    ipcRenderer.on('terminal:session-profile', (event, payload) => callback(payload));
  },
  onTerminalConfirmNeeded: (callback) => {
    ipcRenderer.on('terminal:confirm-needed', (event, payload) => callback(payload));
  },
  onTerminalConfirmCleared: (callback) => {
    ipcRenderer.on('terminal:confirm-cleared', (event, payload) => callback(payload));
  },

  // Topic detection
  refreshTopics: (options) => ipcRenderer.invoke('topic:refresh', options || {}),
  onTopicStatus: (callback) => {
    ipcRenderer.on('topic:status', (event, payload) => callback(payload));
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (apiKey, baseUrl, aiCommand, heartbeat, runtime) =>
    ipcRenderer.invoke('settings:save', { apiKey, baseUrl, aiCommand, heartbeat, runtime }),
  getTabSnapshot: () => ipcRenderer.invoke('tabs:snapshot:get'),
  saveTabSnapshot: (snapshot) => ipcRenderer.invoke('tabs:snapshot:save', { snapshot }),
  queryHeartbeatArchive: (options) => ipcRenderer.invoke('heartbeat:query', options || {}),
  summarizeHeartbeatArchive: (options) => ipcRenderer.invoke('heartbeat:summarize', options || {}),

  // Shortcuts (main -> renderer)
  onNewTab: (callback) => {
    ipcRenderer.on('shortcut:new-tab', () => callback());
  },
  onCloseTab: (callback) => {
    ipcRenderer.on('shortcut:close-tab', () => callback());
  },
  onRefreshTopics: (callback) => {
    ipcRenderer.on('shortcut:refresh-topics', () => callback());
  },
  onShowHeartbeatArchive: (callback) => {
    ipcRenderer.on('shortcut:show-heartbeat-archive', () => callback());
  },
  onNextConfirmTab: (callback) => {
    ipcRenderer.on('shortcut:next-confirm-tab', () => callback());
  },
  onSwitchTab: (callback) => {
    ipcRenderer.on('shortcut:switch-tab', (event, payload) => callback(payload));
  },
  onIncreaseFont: (callback) => {
    ipcRenderer.on('shortcut:increase-font', () => callback());
  },
  onDecreaseFont: (callback) => {
    ipcRenderer.on('shortcut:decrease-font', () => callback());
  },
  onResetFont: (callback) => {
    ipcRenderer.on('shortcut:reset-font', () => callback());
  },
  onPrevTab: (callback) => {
    ipcRenderer.on('shortcut:prev-tab', () => callback());
  },
  onNextTab: (callback) => {
    ipcRenderer.on('shortcut:next-tab', () => callback());
  }
});
