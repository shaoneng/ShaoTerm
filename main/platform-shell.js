const fs = require('fs');
const path = require('path');

function sanitizeShellMode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCandidate(value) {
  return String(value || '').trim();
}

function isPathLikeShell(shell) {
  return /[\\/]/.test(shell) || shell.startsWith('.');
}

function canUseShellPath(shellPath) {
  if (!shellPath) return false;

  if (!isPathLikeShell(shellPath)) {
    return true;
  }

  try {
    const stat = fs.statSync(shellPath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(shellPath, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function appendCandidate(candidates, value, source) {
  const shell = normalizeCandidate(value);
  if (!shell) return;
  if (candidates.some((item) => item.shell === shell)) return;
  candidates.push({ shell, source });
}

function buildUnixCandidates(platform, env, preferredShell) {
  const candidates = [];
  appendCandidate(candidates, preferredShell, 'preferred_shell');
  appendCandidate(candidates, env.SHELL, 'env_shell');

  if (platform === 'darwin') {
    appendCandidate(candidates, '/bin/zsh', 'platform_default');
    appendCandidate(candidates, '/bin/bash', 'platform_fallback');
    appendCandidate(candidates, '/bin/sh', 'platform_fallback');
    return candidates;
  }

  if (platform === 'linux') {
    appendCandidate(candidates, '/bin/bash', 'platform_default');
    appendCandidate(candidates, '/usr/bin/bash', 'platform_fallback');
    appendCandidate(candidates, '/bin/sh', 'platform_fallback');
    appendCandidate(candidates, '/usr/bin/zsh', 'platform_fallback');
    return candidates;
  }

  appendCandidate(candidates, '/bin/sh', 'platform_default');
  return candidates;
}

function buildWindowsCandidates(env, preferredShell) {
  const candidates = [];
  appendCandidate(candidates, preferredShell, 'preferred_shell');
  appendCandidate(candidates, env.SHELL, 'env_shell');
  appendCandidate(candidates, env.ComSpec || env.COMSPEC, 'env_comspec');
  appendCandidate(candidates, 'powershell.exe', 'platform_default');
  appendCandidate(candidates, 'pwsh.exe', 'platform_fallback');
  appendCandidate(candidates, 'cmd.exe', 'platform_fallback');
  return candidates;
}

function basenameLower(shell) {
  return path.basename(String(shell || '')).toLowerCase();
}

function buildShellArgs(shell, platform, shellMode) {
  const mode = sanitizeShellMode(shellMode);
  const lower = basenameLower(shell);
  const fastMode = mode === 'fast';

  if (platform === 'win32') {
    if (lower === 'cmd' || lower === 'cmd.exe') {
      return fastMode ? ['/Q'] : [];
    }

    if (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe') {
      return fastMode ? ['-NoLogo', '-NoProfile'] : ['-NoLogo'];
    }
    return [];
  }

  if (!fastMode) {
    return ['-l'];
  }

  if (lower === 'zsh' || lower === 'zsh.exe') {
    return ['-f'];
  }
  if (lower === 'bash' || lower === 'bash.exe') {
    return ['--noprofile', '--norc'];
  }
  return ['-l'];
}

function resolveShellLaunch(options = {}) {
  const platform = String(options.platform || process.platform);
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const preferredShell = normalizeCandidate(options.preferredShell);
  const shellMode = sanitizeShellMode(options.shellMode);
  const candidates = platform === 'win32'
    ? buildWindowsCandidates(env, preferredShell)
    : buildUnixCandidates(platform, env, preferredShell);

  let chosen = null;
  for (const candidate of candidates) {
    if (canUseShellPath(candidate.shell)) {
      chosen = candidate;
      break;
    }
  }

  if (!chosen) {
    chosen = {
      shell: platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      source: 'emergency_fallback'
    };
  }

  const args = buildShellArgs(chosen.shell, platform, shellMode);
  return {
    shell: chosen.shell,
    args,
    envPatch: {},
    platform,
    shellMode: shellMode || '',
    resolvedFrom: chosen.source,
    isFallback: chosen.source !== 'preferred_shell' && chosen.source !== 'env_shell',
    fallbackReason: chosen.source === 'emergency_fallback' ? 'no_usable_shell_candidate' : ''
  };
}

module.exports = {
  resolveShellLaunch,
  sanitizeShellMode
};
