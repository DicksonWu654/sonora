const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const config = require('./narration/config');
const root = path.resolve(__dirname, '..');

function supportedPlatform(platform, arch) {
  return (['linux', 'win32'].includes(platform) && arch === 'x64') || (platform === 'darwin' && arch === 'arm64');
}

function voiceInstalled() {
  return fs.existsSync(config.python) && ['config.json', 'kokoro-v1_0.pth', 'voices/af_heart.pt', 'voices/af_bella.pt']
    .every(file => fs.existsSync(path.join(config.modelDir, file)));
}

async function launch() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer from https://nodejs.org/ , then start Sonora again.');
  if (!supportedPlatform(process.platform, process.arch)) throw new Error('This installer supports 64-bit Linux/Windows and Apple Silicon Macs. See INSTALL.md for requirements.');
  if (process.argv.includes('--check')) {
    console.log(`Node.js ${process.versions.node}; ${process.platform}/${process.arch}; voice ${voiceInstalled() ? 'installed' : 'needs first-time setup'}.`);
    return;
  }
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a number between 1 and 65535.');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/narration/status`, { signal: AbortSignal.timeout(1500) });
    const status = await response.json();
    if (response.ok && typeof status.ready === 'boolean' && typeof status.state === 'string') {
      console.log(`Sonora is already running at http://127.0.0.1:${port}. Click its browser extension to read.`);
      return;
    }
  } catch { /* Start a new server if no Sonora instance is listening. */ }
  if (!voiceInstalled()) {
    console.log('First launch: installing Python, voice dependencies, and the local model. This needs internet and may take several minutes.');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'narration/setup.js')], { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status || 1; return; }
  }
  console.log(`\nSonora: http://127.0.0.1:${port}\nExtension folder: ${path.join(root, 'extension')}\nKeep this window open while reading. Press Ctrl+C to stop.\n`);
  const server = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: process.env, stdio: 'inherit' });
  const stop = signal => () => server.kill(signal);
  const onInterrupt = stop('SIGINT'), onTerminate = stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  server.on('error', error => { console.error(`Sonora: ${error.message}`); process.exitCode = 1; });
  server.on('exit', (code, signal) => {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.exitCode = signal === 'SIGINT' ? 0 : code ?? 1;
  });
}

if (require.main === module) launch().catch(error => { console.error(`Sonora: ${error.message}`); process.exitCode = 1; });
module.exports = { supportedPlatform };
