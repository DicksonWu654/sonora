const fs = require('node:fs');
const path = require('node:path');
async function install(page, { auto = false, saved = {}, waitForIndex = true, rejectLongTokens = false } = {}) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) { const panel = attach.call(this, options); if(this.id === 'sonora-overlay-root') window.panel = panel; return panel; };
    window.requests = []; window.played = []; window.saved = ${JSON.stringify(saved)}; window.sources = new Map();
    window.autoPlayback = ${auto};window.rejectLongTokens = ${rejectLongTokens};
    window.AudioContext = null; window.webkitAudioContext = null;
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {get() {return this.testSource || '';}, set(value) {this.testSource = value;}});
    HTMLMediaElement.prototype.load = HTMLMediaElement.prototype.pause = function() {};
    HTMLMediaElement.prototype.play = async function() {played.push(sources.get(this.src)); if(autoPlayback) setTimeout(() => this.dispatchEvent(new Event('ended')), 0);};
    window.chrome = {storage: {local: {get: async () => saved, set: async value => Object.assign(saved, value)}}, runtime: {
      onMessage: {addListener(fn) {window.receive = fn;}, removeListener() {}},
      sendMessage(message, fn) {requests.push(message);if(rejectLongTokens&&message.type==='sonora-render'&&/\\S{500,}/u.test(message.text)){fn({ok:false,error:'Unsafe token'});return;}const src = 'audio-' + requests.length;sources.set(src,message.text);fn({ok:true,data:message.type === 'sonora-status' ? {ready:true} : {src,words:[]}});}
    }};
  })()`);
  for (const file of [
    'text.js',
    'speed.js',
    'tempo.js',
    'docs.js',
    'passages.js',
    'speech.js',
    'words.js',
    'overlay.js'
  ])
    await page.evaluate(fs.readFileSync(path.join(__dirname, '../../extension', file), 'utf8'));
  if (waitForIndex) await page.evaluate('window.__sonoraOverlay.whenIndexed');
}
const blocks = (page) =>
  page.evaluate(
    `[...SonoraPassages.blockCandidates(document.querySelector('main') || document.body, 'nav,header,footer,aside,form')].filter(n => SonoraPassages.visibleBlock(n)).map(n => SonoraPassages.readableText(n, BookText.cleanText))`
  );
module.exports = { install, blocks };
