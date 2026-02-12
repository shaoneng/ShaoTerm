/* global Terminal, FitAddon */

const DEBUG_MODE_STORAGE_KEY = 'shaoterm.debug-mode.v1';
const DEBUG_MODE = (() => {
  try {
    const search = new URLSearchParams(window.location.search || '');
    if (search.get('debug') === '1') return true;
    return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === '1';
  } catch (err) {
    return false;
  }
})();

function debugLog(...args) {
  if (!DEBUG_MODE) return;
  console.log(...args);
}

const missingApiWarningSet = new Set();

function callApiSafely(methodName, ...args) {
  if (window.api && typeof window.api[methodName] === 'function') {
    try {
      return window.api[methodName](...args);
    } catch (err) {
      console.warn(`[terminal][api] Failed to call ${methodName}:`, err);
      return undefined;
    }
  }

  if (!missingApiWarningSet.has(methodName)) {
    missingApiWarningSet.add(methodName);
    console.warn(`[terminal][api] Missing bridge method: ${methodName}`);
  }
  return undefined;
}

const DARK_THEME = {
  background: '#23262c',
  foreground: '#d7dce4',
  cursor: '#f4f7ff',
  selectionBackground: '#47556e',
  black: '#1f2430',
  red: '#d36f80',
  green: '#79c08f',
  yellow: '#d7bd79',
  blue: '#75a9ff',
  magenta: '#b493e2',
  cyan: '#72bfd4',
  white: '#d5dae4',
  brightBlack: '#7f8795',
  brightRed: '#e68a9a',
  brightGreen: '#95d7a7',
  brightYellow: '#e8d39a',
  brightBlue: '#96bdff',
  brightMagenta: '#c6aaeb',
  brightCyan: '#93d0df',
  brightWhite: '#eef2fa'
};

const LIGHT_THEME = {
  background: '#f5f7fb',
  foreground: '#303644',
  cursor: '#1e2430',
  selectionBackground: '#cfdaf2',
  black: '#2a2f3b',
  red: '#b85d70',
  green: '#3f8f59',
  yellow: '#8d6b2b',
  blue: '#2f6fc7',
  magenta: '#8a5ec2',
  cyan: '#2e869f',
  white: '#dce1ea',
  brightBlack: '#7f8796',
  brightRed: '#c96f82',
  brightGreen: '#56a56f',
  brightYellow: '#a7833e',
  brightBlue: '#4b84d8',
  brightMagenta: '#9e74cf',
  brightCyan: '#4697af',
  brightWhite: '#eff3fa'
};

class TerminalManager {
  constructor() {
    this.instances = new Map();
    this.isLight = false;
    this.fontSize = 14; // Default font size
    this.scrollStateListeners = new Set();
  }

  create(tabId, containerElement) {
    debugLog(`Creating terminal for tab ${tabId}`);

    const surface = document.createElement('div');
    surface.className = 'terminal-surface';
    containerElement.appendChild(surface);

    const terminal = new Terminal({
      cursorBlink: true,
      scrollOnUserInput: true,
      fontSize: this.fontSize,
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.24,
      drawBoldTextInBrightColors: false,
      theme: this.isLight ? LIGHT_THEME : DARK_THEME
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(surface);
    // Don't fit here — container may be hidden (display:none).
    // ResizeObserver below handles fitting when it becomes visible.

    // Auto-fit whenever the container's size changes (including becoming visible)
    const observer = new ResizeObserver(() => {
      if (surface.offsetWidth > 0 && surface.offsetHeight > 0) {
        fitAddon.fit();
        callApiSafely('resizeTerminal', tabId, terminal.cols, terminal.rows);
        this.emitScrollState(tabId);
      }
    });
    observer.observe(surface);

    const scrollSubscription = terminal.onScroll(() => {
      this.emitScrollState(tabId);
    });

    terminal.onData((data) => {
      const distanceToBottom = terminal.buffer.active.baseY - terminal.buffer.active.viewportY;
      if (distanceToBottom > 0) {
        terminal.scrollToBottom();
      }
      callApiSafely('sendTerminalData', tabId, data);
    });

    // Handle Shift+Enter for newline (send same escape sequence as Option+Enter)
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        debugLog('Shift+Enter detected, sending ESC+Enter sequence');
        // Send ESC + carriage return (same as Option+Enter in xterm.js)
        callApiSafely('sendTerminalData', tabId, '\x1b\r');
        return false; // Prevent default behavior
      }
      return true;
    });

    debugLog('Shift+Enter handler attached');

    // Enable drag and drop for files/folders
    containerElement.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    containerElement.addEventListener('drop', (e) => {
      debugLog('Drop event detected');
      e.preventDefault();
      e.stopPropagation();

      const files = e.dataTransfer.files;
      debugLog(`Dropped ${files.length} files`);

      if (files && files.length > 0) {
        const paths = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          debugLog(`File ${i}:`, file.name, file.path);

          // Try to access path property directly
          const filePath = file.path || file.name;
          const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
          paths.push(quotedPath);
        }

        if (paths.length > 0) {
          const pathString = paths.join(' ');
          debugLog(`Sending paths to terminal: ${pathString}`);
          callApiSafely('sendTerminalData', tabId, pathString);
        }
      }
    });

    debugLog('Drag and drop handlers attached');

    this.instances.set(tabId, {
      terminal,
      fitAddon,
      container: containerElement,
      observer,
      scrollSubscription
    });
    this.emitScrollState(tabId);

    return { cols: terminal.cols, rows: terminal.rows };
  }

  write(tabId, data) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.terminal.write(data, () => {
        this.emitScrollState(tabId);
      });
    }
  }

  fit(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.fitAddon.fit();
      this.emitScrollState(tabId);
      return { cols: instance.terminal.cols, rows: instance.terminal.rows };
    }
    return null;
  }

  focus(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.terminal.focus();
    }
  }

  getScrollDistance(tabId) {
    const instance = this.instances.get(tabId);
    if (!instance || !instance.terminal) return 0;
    return instance.terminal.buffer.active.baseY - instance.terminal.buffer.active.viewportY;
  }

  onScrollStateChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.scrollStateListeners.add(listener);
    return () => {
      this.scrollStateListeners.delete(listener);
    };
  }

  emitScrollState(tabId) {
    if (this.scrollStateListeners.size === 0) return;
    const instance = this.instances.get(tabId);
    if (!instance || !instance.terminal) return;
    const distanceToBottom = this.getScrollDistance(tabId);
    const payload = {
      tabId,
      distanceToBottom,
      isAtBottom: distanceToBottom <= 0
    };
    for (const listener of this.scrollStateListeners) {
      listener(payload);
    }
  }

  isNearBottom(tabId, thresholdLines = 0) {
    const instance = this.instances.get(tabId);
    if (!instance || !instance.terminal) return true;
    const distance = instance.terminal.buffer.active.baseY - instance.terminal.buffer.active.viewportY;
    return distance <= Math.max(0, Number(thresholdLines) || 0);
  }

  ensureInputVisible(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.terminal.scrollToBottom();
      instance.terminal.focus();
      this.emitScrollState(tabId);
    }
  }

  scrollToBottom(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.terminal.scrollToBottom();
      this.emitScrollState(tabId);
    }
  }

  destroy(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.observer.disconnect();
      if (instance.scrollSubscription && typeof instance.scrollSubscription.dispose === 'function') {
        instance.scrollSubscription.dispose();
      }
      instance.terminal.dispose();
      instance.container.remove();
      this.instances.delete(tabId);
    }
  }

  setLightMode(isLight) {
    this.isLight = isLight;
    const theme = isLight ? LIGHT_THEME : DARK_THEME;
    for (const [, { terminal }] of this.instances) {
      terminal.options.theme = theme;
    }
  }

  increaseFontSize() {
    debugLog(`Increasing font size from ${this.fontSize}`);
    this.fontSize = Math.min(this.fontSize + 2, 32); // Max 32px
    debugLog(`New font size: ${this.fontSize}`);
    for (const [tabId, { terminal, fitAddon }] of this.instances) {
      terminal.options.fontSize = this.fontSize;
      // Refit after font size change
      setTimeout(() => {
        fitAddon.fit();
        callApiSafely('resizeTerminal', tabId, terminal.cols, terminal.rows);
      }, 10);
    }
  }

  decreaseFontSize() {
    debugLog(`Decreasing font size from ${this.fontSize}`);
    this.fontSize = Math.max(this.fontSize - 2, 8); // Min 8px
    debugLog(`New font size: ${this.fontSize}`);
    for (const [tabId, { terminal, fitAddon }] of this.instances) {
      terminal.options.fontSize = this.fontSize;
      // Refit after font size change
      setTimeout(() => {
        fitAddon.fit();
        callApiSafely('resizeTerminal', tabId, terminal.cols, terminal.rows);
      }, 10);
    }
  }

  resetFontSize() {
    debugLog(`Resetting font size from ${this.fontSize} to 14`);
    this.fontSize = 14; // Default size
    for (const [tabId, { terminal, fitAddon }] of this.instances) {
      terminal.options.fontSize = this.fontSize;
      // Refit after font size change
      setTimeout(() => {
        fitAddon.fit();
        callApiSafely('resizeTerminal', tabId, terminal.cols, terminal.rows);
      }, 10);
    }
  }
}
