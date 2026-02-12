#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function chmodExecIfExists(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const mode = fs.statSync(filePath).mode;
  const nextMode = mode | 0o111;
  if (nextMode !== mode) {
    fs.chmodSync(filePath, nextMode);
  }
  return true;
}

function run() {
  const repoRoot = process.cwd();
  const helperPaths = [
    path.join(repoRoot, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join(repoRoot, 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
    path.join(repoRoot, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')
  ];

  let fixed = 0;
  for (const helperPath of helperPaths) {
    try {
      if (chmodExecIfExists(helperPath)) {
        fixed += 1;
      }
    } catch (err) {
      console.warn(`[fix-node-pty] Failed to fix permission: ${helperPath}: ${err.message}`);
    }
  }

  console.log(`[fix-node-pty] Checked ${helperPaths.length} helper paths, fixed ${fixed}.`);
}

run();
