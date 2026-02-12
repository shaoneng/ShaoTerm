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

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds'
  );

  const candidates = [
    path.join(appPath, 'darwin-arm64', 'spawn-helper'),
    path.join(appPath, 'darwin-x64', 'spawn-helper')
  ];

  let fixed = 0;
  for (const candidate of candidates) {
    if (chmodExecIfExists(candidate)) {
      fixed += 1;
    }
  }

  console.log(`[afterPack] node-pty spawn-helper fixed=${fixed}`);
};
