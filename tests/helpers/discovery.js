const fs = require('node:fs');
const path = require('node:path');
async function install(page, holdFrames = false) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = attach.call(this, options);
      if (this.id === 'sonora-overlay-root') window.panel = shadow;
      return shadow;
    };
    const timeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => delay === 50
      ? (window.startIndex = callback, 0) : timeout(callback, callback.name === 'batch' ? 40 : delay, ...args);
    window.messages = []; window.spoken = []; window.sources = new Map();
    window.indexed = false; window.playedBeforeIndexing = 0; window.completedBeforeIndexing = false;
    if (${holdFrames}) {
      window.pendingFrames = [];
      window.requestAnimationFrame = callback => pendingFrames.push(callback);
      window.cancelAnimationFrame = () => {};
    }
    window.AudioContext = null; window.webkitAudioContext = null;
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {get() { return this.mockSource || ''; }, set(value) { this.mockSource = value; }});
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
    HTMLMediaElement.prototype.play = async function () {
      spoken.push(sources.get(this.src));
      if (!indexed) playedBeforeIndexing++;
      if (!window.autoPlayback) return;
      const finish = () => {
        this.dispatchEvent(new Event('ended'));
        if (!indexed && panel.querySelector('.status span').textContent.includes('complete')) completedBeforeIndexing = true;
      };
      // Let each play() continuation settle, and yield to real discovery tasks.
      if (spoken.length % 16 === 0) timeout(finish, 0);
      else queueMicrotask(() => queueMicrotask(finish));
    };
    window.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}, runtime: {
      onMessage: {addListener() {}, removeListener() {}},
      sendMessage(message, callback) {
        messages.push(message);
        const src = 'test-audio-' + messages.length;
        sources.set(src, message.text);
        callback({ok: true, data: message.type === 'sonora-status' ? {ready: true} : {src, words: []}});
      }
    }};
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js']) {
    await page.evaluate(
      fs.readFileSync(
        path.join(process.env.SONORA_TEST_EXTENSION || path.join(__dirname, '../../extension'), file),
        'utf8'
      )
    );
  }
  await page.evaluate('void window.__sonoraOverlay.whenIndexed.then(() => { indexed = true; })');
}
async function finishPlayback(page, timeout = 15000) {
  return page.evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    function check() {
      const status = panel.querySelector('.status span').textContent;
      if (status.includes('complete')) { resolve({spoken, indexed, playedBeforeIndexing, completedBeforeIndexing, status}); return; }
      if (performance.now() - started > ${timeout}) { reject(new Error('Playback did not finish: ' + status)); return; }
      setTimeout(check, 10);
    }
    check();
  })`);
}
module.exports = { install, finishPlayback };
