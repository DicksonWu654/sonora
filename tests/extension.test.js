const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const extension = path.join(root, 'extension');
const { extensionAccess } = require('../tools/narration/extension-access');

test('the unpacked extension has a complete Manifest V3 package', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  const overlay = fs.readFileSync(path.join(extension, 'overlay.js'), 'utf8');
  assert.match(overlay, new RegExp(`OVERLAY_VERSION = '${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  for (const file of ['background.js', 'overlay.js', 'page.css', 'reader.html', 'reader.css', 'reader.js', 'text.js', 'validation.js', 'tempo.js', 'docs.js', 'docs-init.js', 'passages.js', 'words.js']) {
    assert(fs.existsSync(path.join(extension, file)), `${file} is missing from the extension`);
  }
  assert.deepEqual(fs.readFileSync(path.join(extension, 'text.js')), fs.readFileSync(path.join(root, 'public', 'text.js')));
  assert(manifest.host_permissions.includes('http://127.0.0.1/*'));
  assert(manifest.host_permissions.includes('http://localhost/*'));
  assert(manifest.host_permissions.includes('https://docs.google.com/*'));
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['https://docs.google.com/document/*'],
    css: ['page.css'],
    run_at: 'document_start'
  }, {
    matches: ['https://docs.google.com/document/*'],
    js: ['docs-init.js'],
    world: 'MAIN',
    run_at: 'document_start'
  }]);
});

test('extension validation keeps narration requests on the local server', () => {
  const validation = require('../extension/validation');
  assert.equal(validation.normalizeServerUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(validation.normalizeServerUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(validation.normalizeServerUrl('https://example.com'), validation.DEFAULT_SERVER);
  assert.equal(validation.normalizeServerUrl('http://127.0.0.1:8787/api'), validation.DEFAULT_SERVER);
  assert.equal(validation.audioUrlFor('http://127.0.0.1:8787', '/api/narration/audio/' + 'a'.repeat(64) + '.wav').pathname, '/api/narration/audio/' + 'a'.repeat(64) + '.wav');
  assert.throws(() => validation.audioUrlFor('http://127.0.0.1:8787', 'https://example.com/audio.wav'), /invalid audio URL/);
  assert(validation.validRenderText('A short passage.'));
  assert(!validation.validRenderText(''));
  assert(!validation.validRenderText('x'.repeat(4001)));
});

test('extension CORS access is limited to local narration routes', () => {
  const req = {
    headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', host: '127.0.0.1:8787' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(extensionAccess(req, '/api/narration/status'), req.headers.origin);
  assert.equal(extensionAccess(req, '/api/narration/render'), req.headers.origin);
  assert.equal(extensionAccess(req, '/api/books'), null);
  assert.equal(extensionAccess({ ...req, socket: { remoteAddress: '192.0.2.1' } }, '/api/narration/status'), null);
});
