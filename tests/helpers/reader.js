const fs = require('node:fs');
const path = require('node:path');
const { browser } = require('./browser');

const publicRoot = path.join(__dirname, '../../public');
const book = Array.from({ length: 4 }, (_, i) =>
  `Paragraph ${i}. ` + `This synthetic sentence keeps the reader fixture long enough to cross chunk boundaries. `.repeat(10)
).join('\n\n');

async function reader(t, { ready = true, nativeAudio = false, source } = {}) {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const page = await browser(t, html, 'http://127.0.0.1:18295/');
  if (!page) return null;
  await page.evaluate(`(() => {
    window.renders = []; window.synthesisCalls = []; window.utterances = [];
    window.ignoreAbort = false;
    window.fetch = async (url, options = {}) => {
      if (url === '/api/narration/status') return {ok: true, json: async () => ({ready: ${ready}, state: ${ready ? "'ready'" : "'loading'"}})};
      if (url === '/api/books') return {ok: true, json: async () => ({jobs: []})};
      if (url !== '/api/narration/render') throw new Error('Unexpected request: ' + url);
      return new Promise((resolve, reject) => {
        const request = {...JSON.parse(options.body), signal: options.signal, aborted: false,
          complete(data = {}) { resolve({ok: true, json: async () => ({audioUrl: '/audio.wav', words: [], ...data})}); },
          fail(message) { reject(new Error(message)); }};
        options.signal?.addEventListener('abort', () => {
          request.aborted = true;
          if (!window.ignoreAbort) reject(new DOMException('Cancelled', 'AbortError'));
        });
        renders.push(request);
      });
    };
    // cancel() clears the queue but does not reset the real API's paused flag.
    // This host has no native voices, so retain that state in the speech double.
    let paused = false, current = null, started = false;
    const startSpeech = () => { if (current && !paused && !started) { started = true; current.onstart?.(); } };
    Object.defineProperty(window, 'speechSynthesis', {value: {
      get paused() { return paused; }, get speaking() { return Boolean(current); }, get pending() { return Boolean(current && !started); },
      cancel() { synthesisCalls.push('cancel'); current = null; started = false; },
      speak(u) { synthesisCalls.push('speak'); utterances.push(u); current = u; started = false; startSpeech(); },
      pause() { synthesisCalls.push('pause'); paused = true; },
      resume() { synthesisCalls.push('resume'); paused = false; startSpeech(); }
    }});
    ${nativeAudio ? '' : `const audio = document.querySelector('#audio');
    window.audioPlays = 0; window.audioPauses = 0;
    Object.defineProperty(audio, 'src', {get() { return this.dataset.src || ''; }, set(value) { this.dataset.src = value; }});
    audio.load = () => {};
    audio.play = async () => { audioPlays++; };
    audio.pause = () => { audioPauses++; };`}
  })()`);
  await page.evaluate(fs.readFileSync(path.join(publicRoot, 'text.js'), 'utf8'));
  await page.evaluate(source || fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8'));
  await page.evaluate(`(async () => showReader(await readBook(new File([${JSON.stringify(book)}], 'synthetic.txt'))))()`);
  return page;
}

module.exports = { reader, book };
