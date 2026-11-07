const fs = require('node:fs');
const path = require('node:path');
async function install(page, setup = null, containment = null) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const value = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = value; return value; };
    window.messages = []; window.wordUpdates = 0;
    window.AudioContext = null; window.webkitAudioContext = null;
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {get() {return this.testSource || '';}, set(value) {this.testSource = value;}});
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {get() {return .1;}, set() {}});
    HTMLMediaElement.prototype.play = async function () {};
    HTMLMediaElement.prototype.pause = HTMLMediaElement.prototype.load = function () {};
    window.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}, runtime: {
      onMessage: {addListener() {}, removeListener() {}},
      sendMessage(message, callback) { messages.push(message); callback({ok: true, data: message.type === 'sonora-status' ? {ready: true} : {src: window.renderSource || 'test-audio', words: [{start: 0, end: 30, textOffset: 0, length: 4}]}}); }
    }};
  })()`);
  if (setup) await page.evaluate(setup);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js']) {
    let script = fs.readFileSync(path.join(__dirname, '../../extension', file), 'utf8');
    if (file === 'overlay.js' && containment)
      script = script.replace(/const CHATGPT_CONTAINMENT = '[^']+';/, `const CHATGPT_CONTAINMENT = '${containment}';`);
    await page.evaluate(script);
    if (file === 'words.js')
      await page.evaluate(`(() => {
      const create = SonoraWords.createTracker;
      SonoraWords.createTracker = (...args) => { const tracker = create(...args), update = tracker.update; tracker.update = (...args) => { wordUpdates++; return update(...args); }; return tracker; };
    })()`);
  }
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
}
const settle = (page) => page.evaluate('new Promise(resolve => setTimeout(resolve, 400))');
const chat = (text) =>
  '<style>p{font:20px/28px sans-serif}pre{font:16px/24px monospace}code{white-space:pre}</style><main><div role="region" aria-label="Conversation"><article data-testid="conversation-turn-0"><div data-message-id="answer" class="markdown">' +
  text +
  '</div></article></div></main>';
module.exports = { install, chat, settle };
