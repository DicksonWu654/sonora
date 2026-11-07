const fs = require('node:fs');
const path = require('node:path');
async function install(page) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = attach.call(this, options);
      if (this.id === 'sonora-overlay-root') window.panel = shadow;
      return shadow;
    };
    window.messages = [];
    window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === 'sonora-status') callback({ok: true, data: {ready: true}});
        if (message.type === 'sonora-cancel-render') callback({ok: true});
      }
    }};
    window.AudioContext = class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } };
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js']) {
    await page.evaluate(fs.readFileSync(path.join(__dirname, '../../extension', file), 'utf8'));
  }
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
}
module.exports = { install };
