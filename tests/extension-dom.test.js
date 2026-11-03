const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, longChatHtml } = require('./helpers/browser');
const files = ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js'];
const script = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function install(page, savedSpeed = 1.25) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const shadow = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = shadow; return shadow; };
    window.messages = []; window.saved = { sonoraSpeed: ${savedSpeed} }; window.pending = new Map();
    window.chrome = { storage: { local: { get: async () => saved, set: async value => Object.assign(saved, value) } }, runtime: { onMessage: { addListener(listener) { window.renderReady = listener; }, removeListener() { window.renderReady = null; } }, sendMessage(message, callback) {
      messages.push(message);
      if (message.type === 'sonora-status') callback({ ok: true, data: { ready: true } });
      else if (message.type === 'sonora-cancel-render') { pending.get(message.requestId)?.({ ok: false, error: 'cancelled' }); pending.delete(message.requestId); callback({ ok: true }); }
      else pending.set(message.requestId, callback);
    } } };
    window.audioStarts = []; window.stretches = [];
    window.AudioContext = class {
      constructor() { this.started = performance.now(); this.destination = {}; }
      get currentTime() { return (performance.now() - this.started) / 1000; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      decodeAudioData() { return Promise.resolve({ duration: 30, numberOfChannels: 1, sampleRate: 24000, getChannelData: () => new Float32Array(720000) }); }
      createBuffer(channels, length, sampleRate) { return { duration: length / sampleRate, copyToChannel() {} }; }
      createBufferSource() { return { playbackRate: {}, connect() {}, disconnect() {}, stop() {}, start(when, offset) { audioStarts.push({ offset, duration: this.buffer.duration }); } }; }
    };
  })()`);
  for (const file of files) {
    await page.evaluate(script(file));
    if (file === 'text.js') await page.evaluate(`(() => { window.splitCalls = 0; const split = BookText.chunksFor; BookText.chunksFor = (...args) => { splitCalls++; return split(...args); }; })()`);
  }
  await page.evaluate(`(() => {
    const stretch = SonoraTempo.stretch;
    SonoraTempo.stretch = (channels, sampleRate, rate) => { stretches.push(rate); return stretch(channels, sampleRate, rate); };
  })()`);
}

test('500-turn ChatGPT DOM bounds streaming discovery, code hit testing, highlights and reinjection', async t => {
  const page = await browser(t, longChatHtml());
  if (!page) return;
  await install(page);
  assert.equal(await page.evaluate('document.querySelectorAll("article").length'), 500);
  assert.equal(await page.evaluate('document.querySelectorAll("pre.sonora-code-block").length'), 100);
  assert.equal(await page.evaluate('panel.querySelector(".speed").value'), '1.3');
  assert.equal(await page.evaluate('saved.sonoraSpeed'), 1.3);

  await page.evaluate(`(() => {
    window.splitCalls = 0;
    window.cost = { turns: [], queries: 0, marks: 0, ranges: 0, comparisons: 0 };
    const visible = SonoraPassages.visibleBlock;
    SonoraPassages.visibleBlock = node => { cost.turns.push(node.closest('article')?.dataset.testid); return visible(node); };
    const query = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (selector) { cost.queries++; return query.call(this, selector); };
    const add = DOMTokenList.prototype.add;
    DOMTokenList.prototype.add = function (...args) { cost.marks++; return add.apply(this, args); };
    const rangeRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () { cost.ranges++; return rangeRects.call(this); };
    const compare = Node.prototype.compareDocumentPosition;
    Node.prototype.compareDocumentPosition = function (other) { cost.comparisons++; return compare.call(this, other); };
    const target = document.querySelector('[data-testid="conversation-turn-499"] p').firstChild;
    for (let index = 0; index < 100; index++) target.appendData(' streamed');
  })()`);
  await delay(220);
  const cost = await page.evaluate('({...cost, splits: splitCalls, turns: [...new Set(cost.turns)]})');
  assert.deepEqual(cost.turns, ['conversation-turn-499']);
  assert(cost.queries < 30, JSON.stringify(cost));
  assert(cost.marks < 10, JSON.stringify(cost));
  assert.equal(cost.splits, 0);
  assert.equal(cost.comparisons, 0, 'streaming must not sort/reindex the full conversation');
  t.diagnostic(`100 streamed mutations: ${cost.queries} scoped queries, ${cost.marks} block marks, 0 full-page comparisons`);

  // Clicks reuse discovered entries; queue construction does no full DOM discovery.
  await page.evaluate(`(() => { cost.turns = []; document.querySelector('[data-testid="conversation-turn-499"] p').click(); })()`);
  assert.deepEqual(await page.evaluate('cost.turns'), []);
  assert.match(await page.evaluate('messages.findLast(item => item.type === "sonora-render").text'), /Turn 499/);
  await page.evaluate(`panel.querySelector('.stop').click()`);
  assert(await page.evaluate('messages.some(item => item.type === "sonora-cancel-render")'));

  // A large syntax-coloured code block must not measure a Range per line on hover/click.
  await page.evaluate(`(() => {
    const code = document.querySelector('code:not(p code)');
    code.innerHTML = Array.from({length: 2000}, (_, index) => '<span>call' + index + '();</span>').join('\\n');
  })()`);
  await delay(220);
  const hit = await page.evaluate(`(() => {
    const span = document.querySelector('pre code span:nth-of-type(1200)');
    span.scrollIntoView({block: 'center'});
    const rect = span.getBoundingClientRect();
    cost.ranges = 0;
    span.dispatchEvent(new MouseEvent('click', {bubbles: true, button: 0, detail: 1, clientX: rect.left + 10, clientY: rect.top + 8}));
    return {text: messages.findLast(item => item.type === 'sonora-render').text, ranges: cost.ranges};
  })()`);
  assert.equal(hit.text, 'call1199();');
  assert(hit.ranges <= 2, JSON.stringify(hit));
  await page.evaluate(`panel.querySelector('.stop').click()`);

  // An unchanged injection toggles; disposal removes observers, frames and page listeners.
  await page.evaluate(script('overlay.js'));
  assert.equal(await page.evaluate('document.querySelectorAll("#sonora-overlay-root").length'), 1);
  await page.evaluate('window.__sonoraOverlay.dispose(); cost.turns = []; document.querySelector("p").firstChild.appendData(" after disposal");');
  await delay(220);
  assert.deepEqual(await page.evaluate('cost.turns'), []);
  assert.equal(await page.evaluate('document.querySelectorAll(".sonora-readable-block").length'), 0);
  assert.deepEqual(page.errors, []);
});

test('realistic code headers, inline code, live speed changes, navigation and hidden text', async t => {
  const page = await browser(t, longChatHtml(6));
  if (!page) return;
  await install(page, 2.25);
  assert.equal(await page.evaluate('panel.querySelector(".speed-value").textContent'), '2.3×');
  const spoken = await page.evaluate(`(() => {
    document.querySelector('p').click();
    const request = messages.findLast(item => item.type === 'sonora-render');
    pending.get(request.requestId)({ok: true, data: {src: 'data:audio/wav;base64,AAAA', words: []}});
    return request.text;
  })()`);
  assert.equal(spoken, 'Turn 0 says answer() aloud.');
  await delay(80);
  await page.evaluate(`(() => { const slider = panel.querySelector('.speed'); slider.value = '1.7'; slider.dispatchEvent(new Event('input')); })()`);
  await delay(20);
  assert.equal(await page.evaluate('panel.querySelector(".speed-value").textContent'), '1.7×');
  assert.equal(await page.evaluate('saved.sonoraSpeed'), 1.7);
  assert.equal(await page.evaluate('stretches.at(-1)'), 1.7);
  const starts = await page.evaluate('audioStarts');
  assert.equal(starts.length, 2);
  assert(starts[1].offset > 0, 'speed change resumes the current passage position');
  await page.evaluate(`panel.querySelector('.stop').click()`);
  const codeText = await page.evaluate(`(() => { document.querySelector('pre').click(); return messages.findLast(item => item.type === 'sonora-render').text; })()`);
  assert.equal(codeText, 'const value0 = 0;');
  assert(!/javascript|Copy|Edit/.test(codeText));
  await page.evaluate(`history.pushState({}, '', '/c/next'); window.dispatchEvent(new PopStateEvent('popstate'));`);
  await delay(220);
  assert.equal(await page.evaluate('document.querySelectorAll(".sonora-current-block").length'), 0);
  assert(await page.evaluate('messages.some(item => item.type === "sonora-cancel-render")'));
  assert.deepEqual(page.errors, []);
});

test('nested generic wrappers produce clickable passages and hide transparent descendants', async t => {
  const page = await browser(t, '<main><div><div><span>Visible article text</span></div></div><div>Mixed <span>inline wrapper</span></div><p>Visible <span style="opacity:0">Copy code</span> prose</p></main>', 'https://example.test/article');
  if (!page) return;
  await install(page);
  const texts = await page.evaluate(`[...document.querySelectorAll('.sonora-readable-block')].map(node => SonoraPassages.readableText(node, BookText.cleanText))`);
  assert.deepEqual(texts, ['Visible article text', 'Mixed inline wrapper', 'Visible prose']);
  assert.deepEqual(page.errors, []);
});


test('a short opening preserves its remainder and prefetches it before the first audio response', async t => {
  const text = Array.from({length: 70}, (_, at) => 'word' + at).join(' ') + '. Following sentence.';
  const page = await browser(t, '<main><p>' + text + '</p></main>');
  if (!page) return;
  await install(page);
  const requests = await page.evaluate(`(() => {
    document.querySelector('p').click();
    const first = messages.find(item => item.type === 'sonora-render');
    renderReady({ type: 'sonora-render-ready', requestId: first.requestId });
    return messages.filter(item => item.type === 'sonora-render').map(item => item.text);
  })()`);
  assert.equal(requests[0].split(/\s+/).length, 25);
  assert.equal(requests.join(' '), text);
  assert.equal(await page.evaluate('audioStarts.length'), 0);
  assert.equal(await page.evaluate('pending.size'), 2, 'only current and next renders may be pending');
  await page.evaluate(`panel.querySelector('.stop').click()`);
  assert.equal(await page.evaluate('pending.size'), 0);
  assert.deepEqual(page.errors, []);
});
