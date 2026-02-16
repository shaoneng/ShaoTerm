function buildBrowserSecurityOptions(options = {}) {
  const preloadPath = String(options.preloadPath || '').trim();
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    enableRemoteModule: false,
    webSecurity: true
  };
}

function decodeFileUrlToPath(rawUrl) {
  const url = String(rawUrl || '');
  if (!url.startsWith('file://')) return '';

  try {
    const decoded = decodeURIComponent(url.replace('file://', ''));
    if (process.platform === 'win32') {
      return decoded
        .replace(/^\/([A-Za-z]:)/, '$1')
        .replace(/\//g, '\\');
    }
    return decoded;
  } catch (err) {
    return '';
  }
}

function attachNavigationGuards(win, options = {}) {
  if (!win || win.isDestroyed()) return;
  const onFileDrop = typeof options.onFileDrop === 'function' ? options.onFileDrop : null;

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    const filePath = decodeFileUrlToPath(url);
    if (!filePath || !onFileDrop) return;
    onFileDrop({ paths: [filePath] });
  });

  if (typeof win.webContents.setWindowOpenHandler === 'function') {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

module.exports = {
  attachNavigationGuards,
  buildBrowserSecurityOptions
};
