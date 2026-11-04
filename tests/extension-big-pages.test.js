const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, longChatHtml } = require('./helpers/browser');

async function install(page) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const value = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = value; return value; };
    const timeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => delay === 50 ? (window.startIndex = callback, 0) : timeout(callback, delay, ...args);
    window.messages = []; window.maxQueue = 0; window.maxSplit = 0;
    const push = Array.prototype.push;
    Array.prototype.push = function (...items) {
      const length = push.apply(this, items);
      if (items.some(item => item?.blockKey && Number.isInteger(item.blockOffset))) maxQueue = Math.max(maxQueue, length);
      return length;
    };
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
    await page.evaluate(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'));
    if (file === 'text.js') await page.evaluate(`(() => {
      const split = BookText.chunksFor;
      BookText.chunksFor = (text, ...args) => { maxSplit = Math.max(maxSplit, text.length); return split(text, ...args); };
    })()`);
  }
}

test('controls and a clicked turn work before the rest of a 2,000-turn page is indexed', async t => {
  const page = await browser(t, longChatHtml(2000));
  if (!page) return;
  await install(page);
  assert.equal(await page.evaluate(`Boolean(panel.querySelector('.controls'))`), true);
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 0);
  await page.evaluate(`document.querySelector('[data-testid="conversation-turn-1999"] p').click()`);
  assert.match(await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`), /Turn 1999/);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 2400);
  assert.deepEqual(page.errors, []);
});

test('a 50,000-word selection resumes after partial extraction and keeps a bounded queue through completion', async t => {
  const text = Array.from({length: 50000}, (_, at) => 'word' + at).join(' ') + '. Last sentence.';
  const page = await browser(t, '<main><p>' + text + '</p></main>');
  if (!page) return;
  await install(page);
  await page.evaluate('document.querySelector("p").click()');
  assert.equal(await page.evaluate(`messages.find(item => item.type === 'sonora-render').text.split(/\\s+/).length`), 20);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  const result = await page.evaluate(`(async () => {
    for (let at = 0; at < 1000 && !panel.querySelector('.status span').textContent.includes('complete'); at++) {
      panel.querySelector('audio').dispatchEvent(new Event('ended'));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { texts: messages.filter(item => item.type === 'sonora-render').map(item => item.text), maxQueue, maxSplit, status: panel.querySelector('.status span').textContent };
  })()`);
  assert.match(result.status, /complete/);
  assert.equal(result.texts.join(' '), text);
  assert(result.maxQueue <= 34, String(result.maxQueue));
  assert(result.maxSplit <= 1201, String(result.maxSplit));
  const replay = await page.evaluate(`(() => { const before = messages.length; panel.querySelector('.play').click(); return messages.slice(before).find(item => item.type === 'sonora-render')?.text; })()`);
  assert.equal(replay, result.texts[0], 'replay starts at the original selection after compacting the queue');
  assert.deepEqual(page.errors, []);
});

test('a deep code click before indexing selects that line rather than the extracted prefix', async t => {
  const code = Array.from({length: 20000}, (_, at) => '<span>call' + at + '();</span>').join('\n');
  const page = await browser(t, '<style>code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code>' + code + '</code></pre></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    window.rangeVisits = 0;
    const createWalker = document.createTreeWalker.bind(document);
    document.createTreeWalker = (...args) => {
      const walker = createWalker(...args), next = walker.nextNode.bind(walker);
      walker.nextNode = () => { rangeVisits++; return next(); };
      return walker;
    };
    const span = document.querySelector('code span:nth-of-type(19000)');
    span.scrollIntoView({block: 'center'});
    const rect = span.getBoundingClientRect();
    span.dispatchEvent(new MouseEvent('click', {bubbles: true, button: 0, detail: 1, clientX: rect.left + 10, clientY: rect.top + 8}));
  })()`);
  for (let attempt = 0; attempt < 100 && !await page.evaluate(`messages.some(item => item.type === 'sonora-render')`); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`), 'call18999();');
  assert(await page.evaluate('rangeVisits < 20'), 'the caret must seed indexing near the selected line');
  assert.deepEqual(page.errors, []);
});

test('idle rediscovery removes paragraphs that shrink or become hidden', async t => {
  const page = await browser(t, '<main><div id="section"><p>Readable paragraph.</p></div></main>', 'https://article.test/read');
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`document.querySelector('p').textContent = 'A'`);
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.evaluate('startIndex()');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 0);
  await page.evaluate(`document.querySelector('p').textContent = 'Readable again.'`);
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.evaluate('startIndex()');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 1);
  await page.evaluate(`document.querySelector('#section').style.display = 'none'`);
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.evaluate('startIndex()');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 0);
  assert.deepEqual(page.errors, []);
});

test('code range marks stay inside a scrolling code container', async t => {
  const page = await browser(t, '<style>pre{width:200px;height:80px;overflow:auto}code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code>' + 'long_name'.repeat(40) + '();</code></pre></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('pre').click()`);
  const result = await page.evaluate(`(() => {
    const clip = document.querySelector('pre').getBoundingClientRect();
    return {right: clip.right, boxes: [...panel.querySelectorAll('.word-mark')].map(node => ({left: parseFloat(node.style.left), width: parseFloat(node.style.width)}))};
  })()`);
  assert(result.boxes.length > 0);
  assert(result.boxes.every(box => box.left + box.width <= result.right));
  assert.deepEqual(page.errors, []);
});

test('clicking deep in an oversized code line selects a bounded chunk containing the clicked word', async t => {
  const words = Array.from({length: 3000}, (_, at) => 'value' + at);
  const text = words.join(' ');
  const page = await browser(t, '<style>pre{width:600px;overflow:auto}code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code>' + text + '</code></pre></main>');
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`(() => {
    const code = document.querySelector('code'), offset = code.textContent.indexOf('value2000');
    const range = document.createRange(); range.setStart(code.firstChild, offset); range.setEnd(code.firstChild, offset + 9);
    code.parentElement.scrollLeft = range.getBoundingClientRect().left - 50;
    const rect = range.getBoundingClientRect();
    code.dispatchEvent(new MouseEvent('click', {bubbles: true, button: 0, detail: 1, clientX: rect.left + 20, clientY: rect.top + 8}));
  })()`);
  const spoken = await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`);
  assert(spoken?.includes('value2000'), spoken);
  assert(spoken.length <= 1200);
  assert.deepEqual(page.errors, []);
});

test('the overlay contains its layout and code clicks prevent native whole-page selection', async t => {
  const page = await browser(t, '<main><pre><code>first();\nnext();</code></pre></main>');
  if (!page) return;
  await install(page);
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#sonora-overlay-root')).contain`), 'strict');
  const result = await page.evaluate(`(() => {
    const code = document.querySelector('code');
    const prevented = !code.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0}));
    const modifierAllowed = code.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0, shiftKey: true}));
    code.click();
    return {prevented, modifierAllowed, text: messages.find(item => item.type === 'sonora-render')?.text};
  })()`);
  assert.deepEqual(result, {prevented: true, modifierAllowed: true, text: 'first();'});
  assert.deepEqual(page.errors, []);
});

test('word rectangles are reused until the word or viewport changes and large paragraphs use bounded marks', async t => {
  const page = await browser(t, '<main><pre><code>first(); next();</code></pre><p>' + 'word '.repeat(10000) + '</p></main>');
  if (!page) return;
  await install(page);
  const result = await page.evaluate(`(() => {
    let reads = 0;
    const getRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () { reads++; return getRects.call(this); };
    const tracker = SonoraWords.createTracker(document, panel);
    const code = document.querySelector('code');
    const entry = {node: code.parentElement, contentNode: code, kind: 'code', text: code.textContent, domRevision: 1};
    tracker.prepare(entry, {text: entry.text, blockOffset: 0}, [{start: 0, end: 1, textOffset: 0, length: 5}]);
    tracker.update(entry, .1);
    const first = reads;
    for (let frame = 0; frame < 120; frame++) tracker.update(entry, .2);
    const stable = reads;
    tracker.invalidate(); tracker.update(entry, .3);
    const moved = reads;
    const paragraph = document.querySelector('p');
    const prose = {node: paragraph, text: paragraph.textContent, domRevision: 2};
    tracker.prepare(prose, {text: 'word', blockOffset: 0}, [{start: 0, end: 1, textOffset: 0, length: 4}]);
    tracker.update(prose, .1);
    const boxes = panel.querySelectorAll('.word-mark').length;
    const registry = CSS.highlights.has('sonora-current-word');
    tracker.reset(true);
    return {first, stable, moved, boxes, registry};
  })()`);
  assert.equal(result.first, 1);
  assert.equal(result.stable, 1);
  assert.equal(result.moved, 2);
  assert(result.boxes > 0);
  assert.equal(result.registry, false);
  assert.deepEqual(page.errors, []);
});

test('prose-only pages do no code hit testing on pointer moves or scrolling', async t => {
  const page = await browser(t, '<main><p>A plain article with no code.</p></main>');
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`(() => {
    window.hitTests = 0;
    const hit = document.elementFromPoint.bind(document);
    document.elementFromPoint = (...args) => { hitTests++; return hit(...args); };
    for (let at = 0; at < 100; at++) {
      document.dispatchEvent(new PointerEvent('pointermove', {clientX: 30, clientY: 40}));
      document.dispatchEvent(new Event('scroll'));
    }
  })()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await page.evaluate('hitTests'), 0);
  assert.deepEqual(page.errors, []);
});

test('replacing a turn during initial idle indexing does not abandon the rest of the conversation', async t => {
  const code = Array.from({length: 20000}, (_, at) => '<span>call' + at + '();</span>').join('\n');
  const html = longChatHtml(500).replace(/<pre>[\s\S]*?<\/pre>/, '<pre><code>' + code + '</code></pre>');
  const page = await browser(t, html);
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    startIndex();
    setTimeout(() => {
      const previous = document.querySelector('article');
      const replacement = document.createElement('article'); replacement.dataset.testid = previous.dataset.testid;
      replacement.innerHTML = '<p>Replacement prose.</p><pre><code>replacement();</code></pre>';
      previous.replaceWith(replacement);
    }, 0);
  })()`);
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 600);
  await page.evaluate(`document.querySelector('[data-testid="conversation-turn-499"] p').click()`);
  assert.match(await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`), /Turn 499/);
  assert.deepEqual(page.errors, []);
});

test('streaming ChatGPT text keeps the same word-mark engine from its first word', async t => {
  const page = await browser(t, '<main><article data-testid="conversation-turn-0"><p>Small opening.</p></article></main>');
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`(() => {
    const audio = panel.querySelector('audio');
    Object.defineProperty(audio, 'src', {get() {return this.savedSource || '';}, set(value) {this.savedSource = value;}});
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => message.type === 'sonora-render'
      ? callback({ok: true, data: {src: 'test-audio', words: [{start: 0, end: 999, textOffset: 0, length: 5}]}})
      : send(message, callback);
    document.querySelector('p').click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(await page.evaluate(`CSS.highlights.has('sonora-current-word')`), false);
  assert.equal(await page.evaluate(`panel.querySelectorAll('.word-mark').length`), 1);
  await page.evaluate(`document.querySelector('p').firstChild.appendData(' token'.repeat(3000))`);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(await page.evaluate(`CSS.highlights.has('sonora-current-word')`), false);
  assert.equal(await page.evaluate(`panel.querySelectorAll('.word-mark').length`), 1);
  assert.deepEqual(page.errors, []);
});
