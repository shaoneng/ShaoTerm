const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBrowserSecurityOptions, attachNavigationGuards } = require('../main/security-policy');

test('buildBrowserSecurityOptions returns strict defaults', () => {
  const result = buildBrowserSecurityOptions({
    preloadPath: '/tmp/preload.js'
  });

  assert.equal(result.preload, '/tmp/preload.js');
  assert.equal(result.contextIsolation, true);
  assert.equal(result.nodeIntegration, false);
  assert.equal(result.enableRemoteModule, false);
  assert.equal(result.webSecurity, true);
});

test('attachNavigationGuards blocks navigation and forwards file drops', () => {
  const listeners = new Map();
  const dropped = [];
  let windowOpenHandler = null;

  const win = {
    isDestroyed: () => false,
    webContents: {
      on(name, handler) {
        listeners.set(name, handler);
      },
      setWindowOpenHandler(handler) {
        windowOpenHandler = handler;
      }
    }
  };

  attachNavigationGuards(win, {
    onFileDrop(payload) {
      dropped.push(payload);
    }
  });

  assert.equal(typeof listeners.get('will-navigate'), 'function');
  assert.equal(typeof listeners.get('will-attach-webview'), 'function');
  assert.equal(typeof windowOpenHandler, 'function');
  assert.deepEqual(windowOpenHandler(), { action: 'deny' });

  let prevented = false;
  listeners.get('will-navigate')(
    {
      preventDefault() {
        prevented = true;
      }
    },
    'file:///tmp/hello%20world.txt'
  );
  assert.equal(prevented, true);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].paths.length, 1);
  assert.ok(dropped[0].paths[0].includes('hello world.txt'));

  prevented = false;
  listeners.get('will-navigate')(
    {
      preventDefault() {
        prevented = true;
      }
    },
    'https://example.com'
  );
  assert.equal(prevented, true);
  assert.equal(dropped.length, 1);

  prevented = false;
  listeners.get('will-attach-webview')({
    preventDefault() {
      prevented = true;
    }
  });
  assert.equal(prevented, true);
});
