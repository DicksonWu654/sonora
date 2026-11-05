const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, longChatHtml, waitFor } = require('./helpers/browser');

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
    await page.evaluate(fs.readFileSync(path.join(process.env.SONORA_TEST_EXTENSION || path.join(__dirname, '../extension'), file), 'utf8'));
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

test('playback waits for ongoing discovery and reads the entire code block and following paragraph', async t => {
  const lines = Array.from({length: 2000}, (_, at) => 'const value' + at + ' = ' + at + ';');
  const html = '<main><pre><code>' + lines.map(line => '<span>' + line + '</span>').join('\n') + '</code></pre><p>Final paragraph.</p></main>';
  const page = await browser(t, html);
  if (!page) return;
  await install(page);
  await page.evaluate(`autoPlayback = true; document.querySelector('pre').click(); startIndex()`);
  const result = await finishPlayback(page);
  assert.equal(result.completedBeforeIndexing, false, 'a temporary empty buffer is not completion');
  assert.equal(result.indexed, true);
  assert(result.playedBeforeIndexing > 0, 'playback must race with real discovery batches');
  assert.deepEqual(result.spoken, [...lines, 'Final paragraph.']);
  assert.deepEqual(page.errors, []);
});

test('article discovery skips recommendation roots inside noise ancestors', async t => {
  const page = await browser(t, '<aside><article><p>Related recommendation card.</p></article></aside><div class="post-content"><h1>Actual article</h1><p id="actual">The main article must remain readable.</p></div>', 'https://article.test/read');
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.sonora-readable-block')].map(node => node.textContent)`), ['Actual article', 'The main article must remain readable.']);
  await page.evaluate(`document.querySelector('#actual').click()`);
  assert.equal(await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`), 'The main article must remain readable.');
  assert.deepEqual(page.errors, []);
});

test('partial Unicode extraction resumes through the full paragraph without corrupting its seam', async t => {
  const text = 'word '.repeat(479) + 'abcd😀 ' + 'rest '.repeat(1000) + 'Final sentence.';
  const page = await browser(t, '<meta charset="utf-8"><main><p>' + text + '</p></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click(); startIndex()`);
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`autoPlayback = true; panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
  const result = await finishPlayback(page, 3000);
  assert.equal(result.spoken.join(' '), text);
  assert(!result.spoken.join('').includes('\ufffd'));
  assert.deepEqual(page.errors, []);
});

test('multiple early selections keep continuous playback in document order during discovery', async t => {
  const page = await browser(t, longChatHtml(100));
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    document.querySelector('[data-testid="conversation-turn-80"] p').click();
    spoken.length = 0; autoPlayback = true;
    document.querySelector('[data-testid="conversation-turn-0"] p').click();
    startIndex();
  })()`);
  const result = await finishPlayback(page);
  const expected = [];
  for (let turn = 0; turn < 100; turn++) {
    expected.push('Turn ' + turn + ' says answer() aloud.');
    if (turn % 5 === 0) for (let line = 0; line < 5; line++) expected.push('const value' + line + ' = ' + (turn + line) + ';');
  }
  assert(result.playedBeforeIndexing > 0, 'audio must advance before discovery completes');
  assert.equal(result.completedBeforeIndexing, false);
  assert.deepEqual(result.spoken, expected);
  assert.deepEqual(page.errors, []);
});

test('code clicks ignore hidden labels and line numbers when selecting their visible line', async t => {
  const html = '<style>code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code><span aria-hidden="true" style="display:none">Hidden Copy code label</span><span>alpha();</span>\n<span aria-hidden="true" style="display:none">Line 2</span><span>beta();</span>\n<span>gamma();</span></code></pre></main>';
  const page = await browser(t, html);
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  for (const [line, expected] of [[0, 'alpha();'], [1, 'beta();'], [2, 'gamma();']]) {
    const point = await page.evaluate(`(() => { const r = document.querySelector('code').getBoundingClientRect(); return {x: r.left + 3, y: r.top + ${line} * 24 + 12}; })()`);
    const before = await page.evaluate('messages.length');
    await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
    assert.equal(await page.evaluate(`messages.slice(${before}).find(item => item.type === 'sonora-render')?.text`), expected);
    await page.evaluate(`panel.querySelector('.stop').click()`);
  }
  assert.deepEqual(page.errors, []);
});

test('semantic language labels beside copy controls are excluded from continuous reading', async t => {
  const page = await browser(t, '<main><p>Read this explanation.</p><div><h3>javascript</h3><button>Copy code</button><pre><code>alpha();\nbeta();</code></pre></div><div><p>python</p><button>Copy</button><pre><code>print(1)</code></pre></div><p>Read the conclusion.</p></main>');
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`autoPlayback = true; document.querySelector('p').click()`);
  const result = await finishPlayback(page);
  assert.deepEqual(result.spoken, ['Read this explanation.', 'alpha();', 'beta();', 'print(1)', 'Read the conclusion.']);
  assert.deepEqual(page.errors, []);
});

test('partial extraction leaves a stable normalized prefix at surrogate and combining boundaries', async t => {
  const page = await browser(t, '<meta charset="utf-8"><main><p></p></main>');
  if (!page) return;
  await install(page);
  const results = await page.evaluate(`(() => {
    const node = document.querySelector('p');
    return ['word '.repeat(479) + 'abcd😀 rest', 'word '.repeat(479) + 'abcde\\u0301 rest', 'x'.repeat(2399) + '😀rest'].map(text => {
      node.textContent = text;
      const partial = SonoraPassages.readableText(node, BookText.cleanText, 2400);
      return {stable: BookText.cleanText(text).startsWith(partial), replacement: partial.includes('\\ufffd')};
    });
  })()`);
  assert.deepEqual(results, Array(3).fill({stable: true, replacement: false}));
  assert.deepEqual(page.errors, []);
});

test('pausing while waiting for discovery prevents automatic resume and resumes at the next passage', async t => {
  const lines = Array.from({length: 500}, (_, at) => 'call' + at + '();');
  const page = await browser(t, '<main><p>First passage.</p><pre><code>' + lines.map(line => '<span>' + line + '</span>').join('\n') + '</code></pre><p>Last passage.</p></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`autoPlayback = true; document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('Finding the next')`);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /Finding the next/);
  assert.equal(await page.evaluate('indexed'), false);
  await page.evaluate(`panel.querySelector('.play').click(); startIndex(); window.__sonoraOverlay.whenIndexed`);
  await waitFor(page, `panel.querySelector('.status span').textContent === 'Paused'`);
  assert.equal(await page.evaluate(`panel.querySelector('.status span').textContent`), 'Paused');
  assert.deepEqual(await page.evaluate('spoken'), ['First passage.']);
  await page.evaluate(`panel.querySelector('.play').click()`);
  const result = await finishPlayback(page);
  assert.deepEqual(result.spoken, ['First passage.', ...lines, 'Last passage.']);
  assert.deepEqual(page.errors, []);
});

test('a deep pre-index code click accounts for hidden labels beyond the partial prefix', async t => {
  const lines = Array.from({length: 500}, (_, at) => (at === 300 ? '<span hidden>Hidden Copy code label</span>' : '') + '<span id="line' + at + '">call' + at + '();</span>');
  const page = await browser(t, '<style>code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code>' + lines.join('\n') + '</code></pre></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    window.prefixBudgets = [];
    const create = SonoraPassages.createTextReader;
    SonoraPassages.createTextReader = (node, clean, end) => {
      const reader = create(node, clean, end);
      if (end) {
        const advance = reader.advance;
        reader.advance = budget => { prefixBudgets.push(budget); return advance.call(reader, budget); };
      }
      return reader;
    };
  })()`);
  const point = await page.evaluate(`(() => { const node = document.querySelector('#line400'); node.scrollIntoView({block: 'center'}); const r = node.getBoundingClientRect(); return {x: r.left + 3, y: r.top + 12}; })()`);
  await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
  await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
  const text = await page.evaluate(`new Promise((resolve, reject) => {
    let tries = 0;
    function check() {
      const value = messages.find(message => message.type === 'sonora-render');
      if (value) resolve(value.text);
      else if (++tries > 200) reject(new Error('No code render request'));
      else setTimeout(check, 5);
    }
    check();
  })`);
  assert.equal(text, 'call400();');
  assert(await page.evaluate('prefixBudgets.length > 0 && prefixBudgets.every(budget => budget <= 2)'), 'filtered prefix work must yield between bounded slices');
  assert.deepEqual(page.errors, []);
});

test('semantic code UI filtering does not rescan a large prose table for each cell', async t => {
  const rows = Array.from({length: 1000}, (_, at) => '<tr><td>Cell ' + at + '</td><td>Other ' + at + '</td></tr>');
  const page = await browser(t, '<main><table>' + rows.join('') + '</table></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    window.tableScans = 0;
    const query = Element.prototype.querySelector;
    Element.prototype.querySelector = function (selector) { if (this.tagName === 'TABLE' && selector === 'pre') tableScans++; return query.call(this, selector); };
    startIndex();
  })()`);
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 2000);
  assert(await page.evaluate('tableScans <= 1'), 'each container needs only one code-presence check per discovery');
  assert.deepEqual(page.errors, []);
});

test('initial discovery waits for the controls paint before spending its page budget', async t => {
  const page = await browser(t, longChatHtml(100));
  if (!page) return;
  await install(page, true);
  await page.evaluate('startIndex()');
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 0);
  await page.evaluate(`for (let frame = 0; frame < 2; frame++) pendingFrames.splice(0).forEach(callback => callback(performance.now()))`);
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^120 clickable blocks/);
  assert.deepEqual(page.errors, []);
});
