/* global Terminal, FitAddon */

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
  }

  create(tabId, containerElement) {
    console.log(`Creating terminal for tab ${tabId}`);

    const surface = document.createElement('div');
    surface.className = 'terminal-surface';
    containerElement.appendChild(surface);

    const terminal = new Terminal({
      cursorBlink: true,
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
        window.api.resizeTerminal(tabId, terminal.cols, terminal.rows);
      }
    });
    observer.observe(surface);

    terminal.onData((data) => {
      window.api.sendTerminalData(tabId, data);
    });

    // Handle Shift+Enter for newline (send same escape sequence as Option+Enter)
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        console.log('Shift+Enter detected, sending ESC+Enter sequence');
        // Send ESC + carriage return (same as Option+Enter in xterm.js)
        window.api.sendTerminalData(tabId, '\x1b\r');
        return false; // Prevent default behavior
      }
      return true;
    });

    console.log('Shift+Enter handler attached');

    // Enable drag and drop for files/folders
    containerElement.addEventListener('dragover', (e) => {
      console.log('Dragover event detected');
      e.preventDefault();
      e.stopPropagation();
    });

    containerElement.addEventListener('drop', (e) => {
      console.log('Drop event detected');
      e.preventDefault();
      e.stopPropagation();

      const files = e.dataTransfer.files;
      console.log(`Dropped ${files.length} files`);

      if (files && files.length > 0) {
        const paths = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          console.log(`File ${i}:`, file.name, file.path);

          // Try to access path property directly
          const filePath = file.path || file.name;
          const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
          paths.push(quotedPath);
        }

        if (paths.length > 0) {
          const pathString = paths.join(' ');
          console.log(`Sending paths to terminal: ${pathString}`);
          window.api.sendTerminalData(tabId, pathString);
        }
      }
    });

    console.log('Drag and drop handlers attached');

    this.instances.set(tabId, { terminal, fitAddon, container: containerElement, observer });

    return { cols: terminal.cols, rows: terminal.rows };
  }

  write(tabId, data) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.terminal.write(data);
    }
  }

  fit(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.fitAddon.fit();
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

  scrollToBottom(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.terminal.scrollToBottom();
    }
  }

  destroy(tabId) {
    const instance = this.instances.get(tabId);
    if (instance) {
      instance.observer.disconnect();
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
    console.log(`Increasing font size from ${this.fontSize}`);
    this.fontSize = Math.min(this.fontSize + 2, 32); // Max 32px
    console.log(`New font size: ${this.fontSize}`);
    for (const [tabId, { terminal, fitAddon }] of this.instances) {
      terminal.options.fontSize = this.fontSize;
      // Refit after font size change
      setTimeout(() => {
        fitAddon.fit();
        window.api.resizeTerminal(tabId, terminal.cols, terminal.rows);
      }, 10);
    }
  }

  decreaseFontSize() {
    console.log(`Decreasing font size from ${this.fontSize}`);
    this.fontSize = Math.max(this.fontSize - 2, 8); // Min 8px
    console.log(`New font size: ${this.fontSize}`);
    for (const [tabId, { terminal, fitAddon }] of this.instances) {
      terminal.options.fontSize = this.fontSize;
      // Refit after font size change
      setTimeout(() => {
        fitAddon.fit();
        window.api.resizeTerminal(tabId, terminal.cols, terminal.rows);
      }, 10);
    }
  }

  resetFontSize() {
    console.log(`Resetting font size from ${this.fontSize} to 14`);
    this.fontSize = 14; // Default size
    for (const [tabId, { terminal, fitAddon }] of this.instances) {
      terminal.options.fontSize = this.fontSize;
      // Refit after font size change
      setTimeout(() => {
        fitAddon.fit();
        window.api.resizeTerminal(tabId, terminal.cols, terminal.rows);
      }, 10);
    }
  }
}
