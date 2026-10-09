// One-time explicit download. Listening itself only reads local assets.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const config = require('./config');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NARRATION_HOME: config.home, HF_HUB_DISABLE_TELEMETRY: '1' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Voice installation stopped (exit ${result.status ?? 'unknown'}). Check the message above, then try again.`);
}

function findUv() {
  const candidates = process.env.UV_BIN ? [process.env.UV_BIN] : [
    'uv', path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
  ];
  for (const command of candidates) {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error('Install uv from https://docs.astral.sh/uv/getting-started/installation/ , reopen your terminal, and start Sonora again.');
}

try {
  const python = path.join(config.home, 'narration-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const uv = findUv();
  fs.mkdirSync(config.home, { recursive: true });
  if (!fs.existsSync(python)) run(uv, ['venv', '--python', '3.12', path.join(config.home, 'narration-venv')]);
  run(uv, ['pip', 'install', '--extra-index-url', 'https://download.pytorch.org/whl/cpu', '--index-strategy', 'unsafe-best-match', '--python', python, '-r', path.join(__dirname, 'requirements.lock')]);
  run(python, [path.join(__dirname, 'setup_model.py')]);
  console.log('Local voices installed. Start Sonora with a launcher or npm run launch.');
} catch (error) {
  console.error(`\nSonora setup: ${error.message}`);
  process.exitCode = 1;
}
