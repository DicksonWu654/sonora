const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, longChatHtml } = require('./helpers/browser');

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
    let script = fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
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

test('review3 live regions inside answers refresh generic prose, status text and code', async (t) => {
  for (const kind of ['live prose', 'status prose', 'live code'])
    await t.test(kind, async (t) => {
      const code = kind === 'live code';
      const html = code
        ? '<pre><code><span id="answer-text" aria-live="polite">alpha();\nbeta();</span></code></pre>'
        : `<div ${kind === 'status prose' ? 'role="status"' : 'aria-live="polite"'}><div id="answer-text">Original answer.</div></div>`;
      const page = await browser(t, chat(html));
      if (!page) return;
      await install(page);
      await page.evaluate(
        `document.querySelector('#answer-text').append(${JSON.stringify(code ? '\ngamma();' : ' New streamed text.')})`
      );
      await settle(page);
      if (code) {
        const point = await page.evaluate(
          `(() => { const node = document.querySelector('#answer-text').lastChild; const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, node.length); const rect = range.getBoundingClientRect(); return {x: rect.left + 3, y: rect.top + 8}; })()`
        );
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      } else await page.evaluate(`document.querySelector('#answer-text').click()`);
      await page.evaluate('new Promise(resolve => setTimeout(resolve, 0))');
      const spoken = await page.evaluate(
        `messages.filter(message => message.type === 'sonora-render').map(message => message.text).join(' ')`
      );
      assert.equal(spoken, code ? 'gamma();' : 'Original answer. New streamed text.');
      assert.deepEqual(page.errors, []);
    });
});

test('review3 revealing a subtree invalidates text edited while it was hidden', async (t) => {
  const page = await browser(t, chat('<div id="wrapper"><p>Original before regeneration.</p></div>'));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('#wrapper').hidden = true`);
  await settle(page);
  await page.evaluate(`document.querySelector('p').textContent = 'Edited during regeneration.'`);
  await settle(page);
  await page.evaluate(`document.querySelector('#wrapper').hidden = false`);
  await settle(page);
  await page.evaluate(`document.querySelector('p').click()`);
  assert.equal(
    await page.evaluate(`messages.find(message => message.type === 'sonora-render')?.text`),
    'Edited during regeneration.'
  );
  assert.deepEqual(page.errors, []);
});

test('review3 containment preserves a nested scrollport anchor on open and close', async (t) => {
  for (const overflowAnchor of ['auto', 'none'])
    await t.test(overflowAnchor, async (t) => {
      const html = `<style>html,body{margin:0;height:100%;overflow:hidden}#scroller{height:100vh;overflow:auto;overflow-anchor:${overflowAnchor}}article{padding:20px;box-sizing:border-box}p{margin:0;font:20px/30px sans-serif}</style><main id="scroller"><div role="region" aria-label="Conversation">${Array.from({ length: 200 }, (_, at) => `<article data-testid="conversation-turn-${at}"><p>${('Turn ' + at + ' long content. ').repeat(at % 7 === 0 ? 400 : 2)}</p></article>`).join('')}</div></main>`;
      const page = await browser(t, html);
      if (!page) return;
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false
      });
      const before = await page.evaluate(
        `(async () => { scroller.scrollTop = scroller.scrollHeight / 2; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); window.anchor = document.elementFromPoint(500, 450).closest('article'); return anchor.getBoundingClientRect().top; })()`
      );
      await install(page, null, 'turn');
      await settle(page);
      assert(
        Math.abs((await page.evaluate('anchor.getBoundingClientRect().top')) - before) < 3,
        'opening must preserve the inner viewport'
      );
      await page.evaluate(`panel.querySelector('.close').click()`);
      await settle(page);
      assert(
        Math.abs((await page.evaluate('anchor.getBoundingClientRect().top')) - before) < 3,
        'closing must preserve the inner viewport'
      );
      assert.equal(await page.evaluate('scrollY'), 0);
      assert.deepEqual(page.errors, []);
    });
});

test('review3 chrome layout changes reposition the same spoken word without rediscovering text', async (t) => {
  const page = await browser(t, chat('<p>Read this word slowly.</p>'));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await settle(page);
  const before = await page.evaluate(`parseFloat(panel.querySelector('.word-mark').style.top)`);
  await page.evaluate(
    `(() => { window.discoveryChecks = 0; const visible = SonoraPassages.visibleBlock; SonoraPassages.visibleBlock = (...args) => { discoveryChecks++; return visible(...args); }; const bar = document.createElement('div'); bar.id = 'toolbar'; bar.setAttribute('role', 'toolbar'); bar.style.height = '120px'; bar.innerHTML = '<button>Copy</button>'; document.querySelector('p').before(bar); })()`
  );
  await settle(page);
  const top = async () =>
    page.evaluate(
      `(() => { const range = document.createRange(); range.setStart(document.querySelector('p').firstChild, 0); range.setEnd(document.querySelector('p').firstChild, 4); return {word: range.getBoundingClientRect().top, highlight: parseFloat(panel.querySelector('.word-mark').style.top)}; })()`
    );
  let position = await top();
  assert(Math.abs(position.word - before - 120) < 2);
  assert(Math.abs(position.word - position.highlight) < 2, JSON.stringify(position));
  await page.evaluate(`document.querySelector('#toolbar').style.height = '240px'`);
  await settle(page);
  position = await top();
  assert(Math.abs(position.word - position.highlight) < 2, JSON.stringify(position));
  assert.equal(await page.evaluate('discoveryChecks'), 0);
  assert.deepEqual(page.errors, []);
});

test('the cached spoken entry follows a replacement conversation root', async (t) => {
  const page = await browser(t, chat('<p>Read this word slowly.</p>'));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await settle(page);
  await page.evaluate(`(() => {
    const root = document.querySelector('[aria-label="Conversation"]');
    const replacement = root.cloneNode(true);
    replacement.style.paddingTop = '120px';
    root.replaceWith(replacement);
  })()`);
  await settle(page);
  const position = await page.evaluate(`(() => {
    const range = document.createRange();
    range.setStart(document.querySelector('p').firstChild, 0); range.setEnd(document.querySelector('p').firstChild, 4);
    return {word: range.getBoundingClientRect().top, highlight: parseFloat(panel.querySelector('.word-mark')?.style.top),
      playing: panel.querySelector('.status span').textContent};
  })()`);
  assert.match(position.playing, /^Playing/);
  assert(Math.abs(position.word - position.highlight) < 2, JSON.stringify(position));
  assert.deepEqual(page.errors, []);
});

test('nested auto-follow and wheel bursts use the conversation scrollport', async (t) => {
  const html =
    '<style>html,body{margin:0;height:100%;overflow:hidden}#scroller{height:100vh;overflow:auto}article{padding:30px}p{font:20px/28px sans-serif}</style><main id="scroller"><div role="region" aria-label="Conversation">' +
    Array.from(
      { length: 200 },
      (_, at) =>
        '<article data-testid="conversation-turn-' +
        at +
        '"><p id="p' +
        at +
        '">Read this paragraph ' +
        at +
        '.</p></article>'
    ).join('') +
    '</div></main>';
  const page = await browser(t, html);
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('#p150').click()`);
  await settle(page);
  const followed = await page.evaluate(
    `(() => { const rect = document.querySelector('#p150').getBoundingClientRect(); return {visible: rect.top >= 0 && rect.bottom <= innerHeight, inner: scroller.scrollTop, outer: scrollY}; })()`
  );
  assert(followed.visible && followed.inner > 0 && followed.outer === 0, JSON.stringify(followed));
  const during = await page.evaluate(`(async () => {
    scroller.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100}));
    wordUpdates = 0;
    for (let at = 0; at < 12; at++) { await new Promise(resolve => setTimeout(resolve, 40)); scroller.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100})); }
    return wordUpdates;
  })()`);
  assert.equal(during, 0, 'tracking must stay suspended past the first 150 ms');
  await settle(page);
  assert(await page.evaluate('wordUpdates > 0'), 'tracking resumes after the burst');
  assert.deepEqual(page.errors, []);
});

test('unchanged decoded audio is reused across passages and playback ticks', async (t) => {
  const page = await browser(t, chat('<p>Read first.</p><p>Read next.</p><p>Read last.</p>'));
  if (!page) return;
  await install(
    page,
    `(() => {
    window.renderSource = 'data:audio/wav;base64,AAAA'; window.decodes = 0; window.byteReads = 0;
    const read = atob; window.atob = value => { byteReads++; return read(value); };
    window.AudioContext = class {
      constructor() {this.currentTime = .1; this.destination = {};}
      resume() {return Promise.resolve();} close() {return Promise.resolve();}
      decodeAudioData() {decodes++; return Promise.resolve({duration: 30, numberOfChannels: 1, sampleRate: 24000, getChannelData: () => new Float32Array(720000)});}
      createBufferSource() {const node = {playbackRate: {}, connect() {}, disconnect() {}, stop() {}, start() {window.playingSource = node;}}; return node;}
    };
  })()`
  );
  await page.evaluate(`document.querySelector('p').click()`);
  await settle(page);
  await page.evaluate('playingSource.onended()');
  await settle(page);
  assert.deepEqual(await page.evaluate('({decodes, byteReads})'), { decodes: 1, byteReads: 1 });
  assert.deepEqual(page.errors, []);
});

test('playback progress writes coalesce to the latest value in one frame', async (t) => {
  const page = await browser(t, chat('<p>Read first.</p><p>Read next.</p>'));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await settle(page);
  const result = await page.evaluate(`(async () => {
    const audio = panel.querySelector('audio'), track = panel.querySelector('.track i');
    Object.defineProperty(audio, 'currentTime', {value: 0, writable: true}); Object.defineProperty(audio, 'duration', {value: 4});
    let writes = 0; const observer = new MutationObserver(records => writes += records.length); observer.observe(track, {attributes: true});
    for (let at = 1; at <= 20; at++) {audio.currentTime = at / 5; audio.dispatchEvent(new Event('timeupdate'));}
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect(); return {writes, transform: track.style.transform};
  })()`);
  assert.equal(result.writes, 1);
  assert.notEqual(result.transform, 'scaleX(0)');
  assert.deepEqual(page.errors, []);
});

test('code word clipping includes the enclosing conversation scrollport', async (t) => {
  const page = await browser(
    t,
    '<style>main{position:absolute;top:200px;left:100px;width:400px;height:120px;overflow:auto}pre{height:500px;margin:0}</style><main><pre><code>Read code.</code></pre></main>'
  );
  if (!page) return;
  await page.evaluate(fs.readFileSync(path.join(__dirname, '../extension/words.js'), 'utf8'));
  const result = await page.evaluate(
    `(() => { const port = document.querySelector('main').getBoundingClientRect(); const clip = SonoraWords.clipFor({node: document.querySelector('pre'), contentNode: document.querySelector('code')}, document); return {top: clip.top, bottom: clip.bottom, expectedTop: port.top, expectedBottom: port.bottom}; })()`
  );
  assert.equal(result.top, result.expectedTop);
  assert.equal(result.bottom, result.expectedBottom);
  assert.deepEqual(page.errors, []);
});

test('containment variants use existing nodes and their stylesheet is removed on close', async (t) => {
  for (const mode of ['none', 'turn', 'coarse'])
    await t.test(mode, async (t) => {
      const page = await browser(t, chat('<p>Read this answer.</p>'));
      if (!page) return;
      await page.evaluate(
        `window.originalRoot = document.querySelector('[aria-label="Conversation"]'); window.originalChildren = [...originalRoot.children]`
      );
      await install(page, null, mode);
      const result = await page.evaluate(`(() => {
      const root = document.querySelector('[aria-label="Conversation"]'), style = document.querySelector('#sonora-chatgpt-visibility');
      return {sameNodes: root === originalRoot && root.children.length === originalChildren.length && [...root.children].every((node, at) => node === originalChildren[at]),
        root: getComputedStyle(root).contentVisibility, turn: getComputedStyle(root.querySelector('article')).contentVisibility, rules: style?.sheet.cssRules.length || 0};
    })()`);
      assert.equal(result.sameNodes, true);
      assert.equal(result.root, mode === 'coarse' ? 'auto' : 'visible');
      assert.equal(result.turn, mode === 'turn' ? 'auto' : 'visible');
      assert.equal(result.rules, mode === 'none' ? 0 : 1);
      await page.evaluate(`panel.querySelector('.close').click()`);
      assert.equal(await page.evaluate(`document.querySelector('#sonora-chatgpt-visibility')`), null);
      assert.equal(await page.evaluate(`getComputedStyle(originalRoot).contentVisibility`), 'visible');
      assert.deepEqual(page.errors, []);
    });
});

test('ChatGPT discovery stays free of passage geometry when containment is disabled', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await install(page, `(() => {
    window.passageRects = 0;
    for (const name of ['getBoundingClientRect', 'getClientRects']) {
      const original = Element.prototype[name];
      Element.prototype[name] = function (...args) {
        if (this.matches('p,pre,li,td,th')) passageRects++;
        return original.apply(this, args);
      };
    }
  })()`, 'none');
  assert.equal(await page.evaluate('passageRects'), 0);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^600 clickable blocks/);
  assert.deepEqual(page.errors, []);
});
