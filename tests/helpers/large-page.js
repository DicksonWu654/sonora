const fs = require('node:fs');
const path = require('node:path');
async function install(page) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const value = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = value; return value; };
    const timeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => delay === 50 ? (window.startIndex = callback, 0) : timeout(callback, delay, ...args);
    window.messages = [];
    window.AudioContext = null; window.webkitAudioContext = null;
    HTMLMediaElement.prototype.play = async function () {};
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
    window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        messages.push(message);
        callback({ok: true, data: message.type === 'sonora-status' ? {ready: true} : {src: 'test-audio', words: []}});
      }
    }};
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js']) {
    await page.evaluate(fs.readFileSync(path.join(__dirname, '../../extension', file), 'utf8'));
  }
}
module.exports = { install };
