const fs = require('node:fs');
const path = require('node:path');
async function install(page, waitForIndex = true, containment = null) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const shadow = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = shadow; return shadow; };
    window.messages = []; window.visibleChecks = 0; window.reads = 0; window.invalidations = 0; window.observations = [];
    const Observer = MutationObserver;
    window.MutationObserver = class extends Observer { observe(node, options) { observations.push({body: node === document.body, ...options}); return super.observe(node, options); } };
    window.AudioContext = null; window.webkitAudioContext = null;
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {get() { return this.testSource || ''; }, set(value) { this.testSource = value; }});
    HTMLMediaElement.prototype.play = async function () {};
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
    window.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}, runtime: {
      onMessage: {addListener() {}, removeListener() {}},
      sendMessage(message, callback) { messages.push(message); callback({ok: true, data: message.type === 'sonora-status' ? {ready: true} : {src: 'test-audio', words: window.renderWords ? [{textOffset: 0, length: 4, start: 0, end: 10}] : []}}); }
    }};
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js']) {
    let script = fs.readFileSync(path.join(__dirname, '../../extension', file), 'utf8');
    if (file === 'overlay.js' && containment)
      script = script.replace(/const CHATGPT_CONTAINMENT = '[^']+';/, `const CHATGPT_CONTAINMENT = '${containment}';`);
    await page.evaluate(script);
    if (file === 'words.js')
      await page.evaluate(`(() => {
      const create = SonoraWords.createTracker;
      SonoraWords.createTracker = (...args) => { const tracker = create(...args), invalidate = tracker.invalidate; tracker.invalidate = () => { invalidations++; invalidate(); }; return tracker; };
    })()`);
  }
  if (waitForIndex) await page.evaluate('window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`(() => {
    const visible = SonoraPassages.visibleBlock, read = SonoraPassages.readableText;
    SonoraPassages.visibleBlock = (...args) => { visibleChecks++; return visible(...args); };
    SonoraPassages.readableText = (...args) => { reads++; return read(...args); };
  })()`);
}
const settle = (page) => page.evaluate('new Promise(resolve => setTimeout(resolve, 350))');
module.exports = { install };
