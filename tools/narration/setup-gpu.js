const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, NARRATION_HOME: config.home } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const directory = path.join(config.home, 'narration-gpu');
const python = path.join(directory, 'bin/python');
const uv = process.env.UV_BIN || 'uv';
// Reuse the operator's installed CUDA PyTorch without modifying its environment.
// All ebook and voice dependencies are installed in our own environment.
if (!fs.existsSync(python)) run(uv, ['venv', '--python', process.env.SONORA_SYSTEM_PYTHON || '/usr/bin/python3', '--system-site-packages', directory]);
run(python, ['-c', 'import torch; assert torch.cuda.is_available(), "A system CUDA PyTorch installation is required; use npm run voice:setup for CPU."; print("CUDA PyTorch:", torch.__version__)']);
run(uv, ['pip', 'install', '--python', python, '--no-deps', '-r', path.join(__dirname, 'requirements-gpu.lock')]);
run(python, [path.join(__dirname, 'setup_model.py')]);
console.log('GPU voice installed. Restart Sonora with npm start.');
