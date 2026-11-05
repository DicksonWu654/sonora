const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, longChatHtml } = require('./helpers/browser');
const { heavyChatHtml } = require('./helpers/chatgpt');

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
    let script = fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
    if (file === 'overlay.js' && containment) script = script.replace(/const CHATGPT_CONTAINMENT = '[^']+';/, `const CHATGPT_CONTAINMENT = '${containment}';`);
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

test('ChatGPT chrome mutations do not rediscover turns or invalidate the spoken word', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    const conversation = document.querySelector('[aria-label="Conversation"]');
    const turn = document.querySelector('article');
    for (let at = 0; at < 100; at++) {
      const bar = document.createElement('div'); bar.setAttribute('role', 'toolbar'); bar.innerHTML = '<button>Copy response</button>';  turn.append(bar); bar.remove();
      const wrapper = document.createElement('div'); wrapper.innerHTML = '<div> <button>Copy</button> <button>More</button> </div>'; turn.append(wrapper); wrapper.remove();
      const tooltip = document.createElement('div'); tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = 'More actions'; conversation.append(tooltip); tooltip.remove();
      const status = document.createElement('span'); status.setAttribute('aria-live', 'polite'); status.textContent = 'Updated'; conversation.append(status); status.remove();
    }
    const sidebar = document.createElement('aside'); sidebar.innerHTML = '<p>Sidebar content.</p>'; document.body.append(sidebar); sidebar.firstChild.textContent = 'Sidebar updated.';
    const form = document.createElement('form'); form.innerHTML = '<textarea>Composer</textarea>'; conversation.append(form);
    const time = document.createElement('time'); time.textContent = 'Now'; turn.append(time); time.firstChild.appendData(' updated');
  })()`);
  await settle(page);
  assert.deepEqual(await page.evaluate('({visibleChecks, reads, invalidations})'), {
    visibleChecks: 0,
    reads: 0,
    invalidations: 0
  });
  assert.equal(await page.evaluate('observations.some(options => options.body && options.subtree)'), false);
  assert.deepEqual(page.errors, []);
});

test('unscoped readable text still refreshes while unrelated UI is ignored', async (t) => {
  const page = await browser(t, longChatHtml(5));
  if (!page) return;
  await install(page);
  await page.evaluate(
    `(() => { const paragraph = document.createElement('p'); paragraph.id = 'new-prose'; paragraph.textContent = 'New readable paragraph.'; document.querySelector('[aria-label="Conversation"]').append(paragraph); })()`
  );
  await settle(page);
  const first = await page.evaluate(
    `(() => { const before = messages.length; document.querySelector('#new-prose').click(); return messages.slice(before).find(message => message.type === 'sonora-render')?.text; })()`
  );
  assert.equal(first, 'New readable paragraph.');
  await page.evaluate(
    `panel.querySelector('.stop').click(); document.querySelector('#new-prose').firstChild.appendData(' Streamed text.')`
  );
  await settle(page);
  const updated = await page.evaluate(
    `(async () => { const before = messages.length; document.querySelector('#new-prose').click(); await new Promise(resolve => setTimeout(resolve, 0)); return messages.slice(before).filter(message => message.type === 'sonora-render').map(message => message.text).join(' '); })()`
  );
  assert.equal(updated, 'New readable paragraph. Streamed text.');
  assert.deepEqual(page.errors, []);
});

test('ChatGPT turn containment is a removable stylesheet and does not mark every passage', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await install(page, true, 'turn');
  const active = await page.evaluate(`(() => {
    const turn = document.querySelector('article');
    return {visibility: getComputedStyle(turn).contentVisibility, intrinsic: getComputedStyle(turn).containIntrinsicSize,
      marked: document.querySelectorAll('.sonora-readable-block').length, styles: [...document.querySelectorAll('style')].filter(style => style.id === 'sonora-chatgpt-visibility').length};
  })()`);
  assert.equal(active.visibility, 'auto');
  assert.match(active.intrinsic, /auto/);
  assert.equal(active.marked, 0);
  assert.equal(active.styles, 1);
  assert.equal(
    await page.evaluate(
      `(() => { const rect = panel.querySelector('.panel').getBoundingClientRect(); return rect.width > 300 && rect.height > 100 && rect.left >= 0 && rect.right <= innerWidth; })()`
    ),
    true
  );
  await page.evaluate(`panel.querySelector('.minimize').click()`);
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('article')).contentVisibility`), 'auto');
  await page.evaluate('window.__sonoraOverlay.toggle()');
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('article')).contentVisibility`), 'auto');
  await page.evaluate(`panel.querySelector('.close').click()`);
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('article')).contentVisibility`), 'visible');
  assert.equal(await page.evaluate(`document.querySelector('#sonora-chatgpt-visibility')`), null);
  assert.deepEqual(page.errors, []);
});

test('scroll and pointer bursts on idle ChatGPT do no passage geometry work', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    window.rectReads = 0;
    for (const [owner, name] of [[Element.prototype, 'getBoundingClientRect'], [Element.prototype, 'getClientRects'], [Range.prototype, 'getClientRects']]) {
      const read = owner[name]; owner[name] = function (...args) { rectReads++; return read.apply(this, args); };
    }
    const paragraph = document.querySelector('p');
    for (let at = 0; at < 100; at++) {
      paragraph.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: 20, clientY: 20}));
      document.dispatchEvent(new Event('scroll'));
    }
  })()`);
  await settle(page);
  assert.equal(await page.evaluate('rectReads'), 0);
  assert.deepEqual(page.errors, []);
});

test('turn containment preserves the viewport anchor, native find and distant code clicks', async (t) => {
  const page = await browser(t, heavyChatHtml(600));
  if (!page) return;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  const anchor = await page.evaluate(`(async () => {
    const scroller = document.querySelector('#chat-scroll'); scroller.scrollTop = scroller.scrollHeight / 2;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const turn = document.elementFromPoint(550, 400).closest('article');
    window.anchorTurn = turn;
    return {id: turn.dataset.testid, top: turn.getBoundingClientRect().top};
  })()`);
  await install(page);
  const top = await page.evaluate('anchorTurn.getBoundingClientRect().top');
  assert(Math.abs(top - anchor.top) < 5, JSON.stringify({ anchor, top }));
  assert.equal(await page.evaluate(`window.find('FindTheDistantNeedle', false, false, true)`), true);
  const found = await page.evaluate(`getSelection().anchorNode.parentElement.closest('article').dataset.testid`);
  assert.equal(found, 'conversation-turn-598');
  await page.evaluate(
    `getSelection().removeAllRanges(); window.renderWords = true; document.querySelector('#text-598').click()`
  );
  assert.match(
    await page.evaluate(`messages.find(message => message.type === 'sonora-render')?.text`),
    /^FindTheDistantNeedle/
  );
  await settle(page);
  assert.equal(await page.evaluate(`panel.querySelector('.word-mark')?.dataset.word`), 'Find');
  await page.evaluate(`panel.querySelector('.stop').click()`);
  const point = await page.evaluate(`(async () => {
    const span = document.querySelector('[data-testid="conversation-turn-595"] pre code .variable');
    span.scrollIntoView({block: 'center'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = span.getBoundingClientRect(); return {x: rect.left + 3, y: rect.top + 8};
  })()`);
  await page.evaluate('window.beforeCodeClick = messages.length');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  assert.equal(
    await page.evaluate(`messages.slice(beforeCodeClick).find(message => message.type === 'sonora-render')?.text`),
    'const value0 = calculate(0);'
  );
  await page.evaluate(
    `window.closeTop = document.querySelector('[data-testid="conversation-turn-595"]').getBoundingClientRect().top`
  );
  const closePoint = await page.evaluate(
    `(() => { const rect = panel.querySelector('.close').getBoundingClientRect(); return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}; })()`
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...closePoint });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...closePoint });
  assert.equal(await page.evaluate(`document.querySelector('#sonora-overlay-root')`), null);
  const closeDelta = await page.evaluate(
    `Math.abs(document.querySelector('[data-testid="conversation-turn-595"]').getBoundingClientRect().top - closeTop)`
  );
  assert(closeDelta < 5, 'closing must preserve the viewport: ' + closeDelta);
  assert.deepEqual(page.errors, []);
});

test('reading reveals skipped turns and user scrolling suspends automatic following', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('[data-testid="conversation-turn-490"] p').click()`);
  await settle(page);
  assert.equal(
    await page.evaluate(
      `(() => { const rect = document.querySelector('[data-testid="conversation-turn-490"] p').getBoundingClientRect(); return rect.top >= 0 && rect.bottom < innerHeight; })()`
    ),
    true
  );
  await page.evaluate(`scrollTo(0, 0)`);
  await settle(page);
  const requests = await page.evaluate(`messages.filter(message => message.type === 'sonora-render').length`);
  await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
  await settle(page);
  assert.equal(await page.evaluate('scrollY'), 0);
  assert(await page.evaluate(`messages.filter(message => message.type === 'sonora-render').length > ${requests}`));
  assert.deepEqual(page.errors, []);
});

test('an aria-live message remains readable when the site streams its content', async (t) => {
  const page = await browser(
    t,
    '<main><article data-testid="conversation-turn-0"><div data-message-id="answer" aria-live="polite"><p>Opening text.</p></div></article></main>'
  );
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').textContent = 'Streamed replacement.'`);
  await settle(page);
  await page.evaluate(`document.querySelector('p').click()`);
  assert.equal(
    await page.evaluate(`messages.find(message => message.type === 'sonora-render')?.text`),
    'Streamed replacement.'
  );
  assert.deepEqual(page.errors, []);
});

test('wheel and pointer activity defer indexing even when the page cannot scroll further', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await page.evaluate(`(() => {
    const timeout = setTimeout;
    window.setTimeout = (callback, delay, ...args) => delay === 50 ? (window.startIndex = callback, 0) : timeout(callback, delay, ...args);
  })()`);
  await install(page, false);
  await page.evaluate(`(() => {
    document.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100}));
    startIndex();
    for (let at = 0; at < 100; at++) document.dispatchEvent(new PointerEvent('pointermove', {bubbles: true}));
  })()`);
  await page.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  assert.equal(await page.evaluate('visibleChecks'), 0);
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^600 clickable blocks/);
  assert.deepEqual(page.errors, []);
});

test('scrolling freezes visual progress updates while playback continues, then catches up', async (t) => {
  const page = await browser(t, longChatHtml(20));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await page.evaluate(`(() => {
    const audio = panel.querySelector('audio');
    Object.defineProperty(audio, 'duration', {value: 4});
    Object.defineProperty(audio, 'currentTime', {value: 1, writable: true});
    audio.dispatchEvent(new Event('timeupdate'));
    window.progressBeforeScroll = panel.querySelector('.track i').style.transform;
    document.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100}));
    audio.currentTime = 2;
    audio.dispatchEvent(new Event('timeupdate'));
  })()`);
  assert.equal(await page.evaluate(`panel.querySelector('.track i').style.transform === progressBeforeScroll`), true);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /^Playing/);
  await settle(page);
  await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('timeupdate')); new Promise(resolve => requestAnimationFrame(resolve))`);
  assert.equal(await page.evaluate(`panel.querySelector('.track i').style.transform === progressBeforeScroll`), false);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /^Playing/);
  assert.deepEqual(page.errors, []);
});

test('moving the conversation preserves observation of subsequent root replacement', async (t) => {
  const page = await browser(t, longChatHtml(5));
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    const conversation = document.querySelector('[aria-label="Conversation"]');
    const group = document.createElement('section'), holder = document.createElement('div');
    conversation.replaceWith(group); group.append(holder); holder.append(conversation);
  })()`);
  await page.evaluate(`(() => {
    const previous = document.querySelector('[aria-label="Conversation"]');
    const holder = previous.parentElement;
    const replacement = document.createElement('div');
    replacement.innerHTML = '<div role="region" aria-label="Conversation"><article data-testid="conversation-turn-0"><p id="moved-replacement">Replacement after moving the conversation.</p></article></div>';
    holder.replaceWith(replacement);
  })()`);
  await settle(page);
  await page.evaluate(`document.querySelector('#moved-replacement').click()`);
  assert.equal(
    await page.evaluate(`messages.find(message => message.type === 'sonora-render')?.text`),
    'Replacement after moving the conversation.'
  );
  assert.deepEqual(page.errors, []);
});
