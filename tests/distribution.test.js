const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { supportedPlatform } = require('../tools/launch');
const { assertPublicFiles } = require('../tools/release');

test('release packaging rejects runtime data, environment secrets, private keys, books, and generated audio', () => {
  for (const file of ['.runtime/config.json', '.env', '.env.local', 'nested/.env.production', 'private.key', 'book.epub', 'book.pdf', 'voice.wav', 'model.pth', 'output/playwright/screenshot.png', 'node_modules/package/index.js']) {
    assert.throws(() => assertPublicFiles([file]), /Private or generated file/);
  }
  assert.doesNotThrow(() => assertPublicFiles(['README.md', '.env.example', 'extension/manifest.json', 'public/moby-dick.txt']));
});

test('launcher diagnostic checks a fresh environment without creating files or installing software', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-launch-check-'));
  try {
    const home = path.join(directory, 'voice');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../tools/launch.js'), '--check'], {
      encoding: 'utf8', env: { ...process.env, NARRATION_HOME: home, NARRATION_PYTHON: path.join(home, 'missing-python'), UV_BIN: path.join(directory, 'missing-uv') }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /needs first-time setup/);
    assert.equal(fs.existsSync(home), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('launcher rejects platforms without compatible pinned CPU wheels', () => {
  assert(supportedPlatform('linux', 'x64'));
  assert(supportedPlatform('win32', 'x64'));
  assert(supportedPlatform('darwin', 'arm64'));
  assert.equal(supportedPlatform('darwin', 'x64'), false);
  assert.equal(supportedPlatform('linux', 'arm64'), false);
  assert.equal(supportedPlatform('win32', 'ia32'), false);
});
