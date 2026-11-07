const test = require('node:test');
const assert = require('node:assert/strict');
const { extensionAccess } = require('../tools/narration/extension-access');

test('extension narration access stays on authorized loopback routes', (t) => {
  {
    const validation = require('../extension/validation');
    assert.equal(validation.normalizeServerUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
    assert.equal(validation.normalizeServerUrl('http://localhost:8787'), 'http://localhost:8787');
    assert.equal(validation.normalizeServerUrl('https://example.com'), validation.DEFAULT_SERVER);
    assert.equal(validation.normalizeServerUrl('http://127.0.0.1:8787/api'), validation.DEFAULT_SERVER);
    assert.equal(
      validation.audioUrlFor('http://127.0.0.1:8787', '/api/narration/audio/' + 'a'.repeat(64) + '.wav').pathname,
      '/api/narration/audio/' + 'a'.repeat(64) + '.wav'
    );
    assert.throws(
      () => validation.audioUrlFor('http://127.0.0.1:8787', 'https://example.com/audio.wav'),
      /invalid audio URL/
    );
    assert(validation.validRenderText('A short passage.'));
    assert(!validation.validRenderText(''));
    assert(!validation.validRenderText('x'.repeat(4001)));
  }
  {
    const req = {
      headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', host: '127.0.0.1:8787' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    assert.equal(extensionAccess(req, '/api/narration/status'), req.headers.origin);
    assert.equal(extensionAccess(req, '/api/narration/render'), req.headers.origin);
    assert.equal(extensionAccess(req, '/api/books'), null);
    assert.equal(extensionAccess({ ...req, socket: { remoteAddress: '192.0.2.1' } }, '/api/narration/status'), null);
  }
});
