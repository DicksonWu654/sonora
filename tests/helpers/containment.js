const fs = require('node:fs');
const path = require('node:path');
async function install(page, nativeMedia = false, waitForContainment = true) {
  const wav = Buffer.alloc(44 + 48000);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const value = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = value; return value; };
    window.AudioContext = null; window.webkitAudioContext = null;
    HTMLMediaElement.prototype.play = async function () {};
    ${
      nativeMedia
        ? ''
        : `Object.defineProperty(HTMLMediaElement.prototype, 'src', {get() {return this.testSource || '';}, set(value) {this.testSource = value;}});
    HTMLMediaElement.prototype.pause = HTMLMediaElement.prototype.load = function () {};`
    }
    window.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}, runtime: {
      onMessage: {addListener() {}, removeListener() {}},
      sendMessage(message, callback) { callback({ok: true, data: message.type === 'sonora-status' ? {ready: true} :
        {src: ${JSON.stringify(nativeMedia ? 'data:audio/wav;base64,' + wav.toString('base64') : 'test-audio')}, words: [{start: 0, end: 30, textOffset: 0, length: 4}]}}); }
    }};
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js'])
    await page.evaluate(fs.readFileSync(path.join(__dirname, '../../extension', file), 'utf8'));
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  if (waitForContainment) await page.evaluate('window.__sonoraOverlay.whenContained');
}
function chat(location, kind = 'both') {
  const controls =
    (kind === 'sticky' ? '' : '<button id="fixed">Jump to bottom</button>') +
    (kind === 'fixed' ? '' : '<div id="sticky">Sticky controls</div>');
  const turns = Array.from(
    { length: 40 },
    (_, at) =>
      `<article data-testid="conversation-turn-${at}">${location === 'turn' && at === 10 ? controls : ''}<p>Read this answer ${at}.</p></article>`
  ).join('');
  return `<style>html,body{margin:0;height:100%;overflow:hidden}#scroller{height:100vh;overflow:auto}article{height:240px;padding:20px;box-sizing:border-box}p{font:20px/28px sans-serif;margin:0}#fixed{position:fixed;bottom:25px;left:30px;height:24px}#sticky{position:sticky;top:20px;height:30px;z-index:1}</style>
    <main id="scroller"><div role="region" aria-label="Conversation">${location === 'region' ? controls : ''}<div id="turns">${location === 'stack' ? controls : ''}${turns}</div></div></main>`;
}
const positions = `(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return Object.fromEntries(['fixed', 'sticky'].filter(id => document.getElementById(id)).map(id => {const r = document.getElementById(id).getBoundingClientRect(); return [id, {top: r.top, left: r.left, width: r.width, height: r.height}];}));
})()`;
module.exports = { install, chat, positions };
