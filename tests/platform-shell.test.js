const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveShellLaunch } = require('../main/platform-shell');

test('uses preferred shell in fast mode for zsh', () => {
  const result = resolveShellLaunch({
    platform: 'darwin',
    env: {},
    preferredShell: 'zsh',
    shellMode: 'fast'
  });

  assert.equal(result.shell, 'zsh');
  assert.deepEqual(result.args, ['-f']);
  assert.equal(result.resolvedFrom, 'preferred_shell');
  assert.equal(result.isFallback, false);
});

test('uses env shell for unix login mode', () => {
  const result = resolveShellLaunch({
    platform: 'linux',
    env: { SHELL: 'bash' },
    preferredShell: '',
    shellMode: ''
  });

  assert.equal(result.shell, 'bash');
  assert.deepEqual(result.args, ['-l']);
  assert.equal(result.resolvedFrom, 'env_shell');
  assert.equal(result.isFallback, false);
});

test('falls back to platform default on win32', () => {
  const result = resolveShellLaunch({
    platform: 'win32',
    env: {},
    preferredShell: '',
    shellMode: ''
  });

  assert.equal(result.shell, 'powershell.exe');
  assert.deepEqual(result.args, ['-NoLogo']);
  assert.equal(result.resolvedFrom, 'platform_default');
  assert.equal(result.isFallback, true);
});

test('supports cmd fast mode on win32', () => {
  const result = resolveShellLaunch({
    platform: 'win32',
    env: {},
    preferredShell: 'cmd.exe',
    shellMode: 'fast'
  });

  assert.equal(result.shell, 'cmd.exe');
  assert.deepEqual(result.args, ['/Q']);
  assert.equal(result.resolvedFrom, 'preferred_shell');
  assert.equal(result.isFallback, false);
});
