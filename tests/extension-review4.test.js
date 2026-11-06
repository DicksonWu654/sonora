const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, longChatHtml, waitFor } = require('./helpers/browser');

async function install(page, nativeMedia = false, waitForContainment = true) {
  const wav = Buffer.alloc(44 + 48000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const value = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = value; return value; };
    window.AudioContext = null; window.webkitAudioContext = null;
    HTMLMediaElement.prototype.play = async function () {};
    ${nativeMedia ? '' : `Object.defineProperty(HTMLMediaElement.prototype, 'src', {get() {return this.testSource || '';}, set(value) {this.testSource = value;}});
    HTMLMediaElement.prototype.pause = HTMLMediaElement.prototype.load = function () {};`}
    window.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}, runtime: {
      onMessage: {addListener() {}, removeListener() {}},
      sendMessage(message, callback) { callback({ok: true, data: message.type === 'sonora-status' ? {ready: true} :
        {src: ${JSON.stringify(nativeMedia ? 'data:audio/wav;base64,' + wav.toString('base64') : 'test-audio')}, words: [{start: 0, end: 30, textOffset: 0, length: 4}]}}); }
    }};
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js'])
    await page.evaluate(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'));
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  if (waitForContainment) await page.evaluate('window.__sonoraOverlay.whenContained');
}

function chat(location, kind = 'both') {
  const controls = (kind === 'sticky' ? '' : '<button id="fixed">Jump to bottom</button>') + (kind === 'fixed' ? '' : '<div id="sticky">Sticky controls</div>');
  const turns = Array.from({length: 40}, (_, at) => `<article data-testid="conversation-turn-${at}">${location === 'turn' && at === 10 ? controls : ''}<p>Read this answer ${at}.</p></article>`).join('');
  return `<style>html,body{margin:0;height:100%;overflow:hidden}#scroller{height:100vh;overflow:auto}article{height:240px;padding:20px;box-sizing:border-box}p{font:20px/28px sans-serif;margin:0}#fixed{position:fixed;bottom:25px;left:30px;height:24px}#sticky{position:sticky;top:20px;height:30px;z-index:1}</style>
    <main id="scroller"><div role="region" aria-label="Conversation">${location === 'region' ? controls : ''}<div id="turns">${location === 'stack' ? controls : ''}${turns}</div></div></main>`;
}

const positions = `(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return Object.fromEntries(['fixed', 'sticky'].filter(id => document.getElementById(id)).map(id => {const r = document.getElementById(id).getBoundingClientRect(); return [id, {top: r.top, left: r.left, width: r.width, height: r.height}];}));
})()`;

test('review4 containment preserves fixed and sticky controls outside and inside the turn wrapper', async (t) => {
  for (const location of ['region', 'stack', 'turn']) for (const kind of ['both', 'fixed', 'sticky']) await t.test(location + ' ' + kind, async (t) => {
    const page = await browser(t, chat(location, kind));
    if (!page) return;
    await page.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await page.evaluate('scroller.scrollTop = 2500; window.originalTurns = [...document.querySelectorAll("article")]');
    const before = await page.evaluate(positions);
    await page.evaluate('scroller.scrollTop = 2550');
    const afterScroll = await page.evaluate(positions);
    await page.evaluate('scroller.scrollTop = 2500');
    await install(page);
    assert.deepEqual(await page.evaluate(positions), before, 'opening preserves both controls');
    const styles = await page.evaluate(`({root: getComputedStyle(document.querySelector('[aria-label="Conversation"]')).contentVisibility, turns: getComputedStyle(document.querySelector('#turns')).contentVisibility})`);
    assert.equal(styles.root, 'visible');
    assert.equal(styles.turns, location === 'region' ? 'auto' : 'visible');
    assert(await page.evaluate('[...document.querySelectorAll("article")].every((node, at) => node === originalTurns[at])'));
    await page.evaluate('scroller.scrollTop = 2550');
    assert.deepEqual(await page.evaluate(positions), afterScroll, 'scrolling preserves viewport and sticky positioning');
    await page.evaluate('panel.querySelector(".close").click()');
    assert.deepEqual(await page.evaluate(positions), afterScroll, 'closing preserves both controls');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#turns")).contentVisibility'), 'visible');
    assert.deepEqual(page.errors, []);
  });
});

test('containment falls back when a positioned control is inserted or restyled after opening', async (t) => {
  for (const change of ['insert', 'style', 'class']) for (const position of ['fixed', 'sticky']) await t.test(change + ' ' + position, async (t) => {
    const page = await browser(t, chat('none') + '<style>.floating{position:fixed;bottom:25px;left:30px;height:24px}.sticking{position:sticky;top:20px}</style>');
    if (!page) return;
    if (change !== 'insert') await page.evaluate(`(() => {const control = document.createElement('button'); control.id = 'late'; control.textContent = 'Controls'; document.querySelector('#turns').prepend(control);})()`);
    await page.evaluate('scroller.scrollTop = 2500');
    await install(page);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#turns")).contentVisibility'), 'auto');
    await page.evaluate(`(() => {
      const control = document.querySelector('#late') || document.createElement('button');
      control.id = 'late'; control.textContent = 'Controls';
      ${change === 'class' ? `control.className = ${JSON.stringify(position === 'fixed' ? 'floating' : 'sticking')};` : `control.style.cssText = ${JSON.stringify('position:' + position + ';bottom:25px;top:' + (position === 'sticky' ? '20px' : 'auto') + ';left:30px;height:24px')};`}
      ${change === 'insert' ? `document.querySelector('#turns').prepend(control);` : ''}
    })()`);
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#turns")).contentVisibility'), 'visible');
    const before = await page.evaluate('document.querySelector("#late").getBoundingClientRect().top');
    await page.evaluate('panel.querySelector(".close").click()');
    assert.equal(await page.evaluate('document.querySelector("#late").getBoundingClientRect().top'), before);
    if (position === 'fixed') assert.equal(await page.evaluate('document.querySelector("#late").getBoundingClientRect().bottom'), (await page.evaluate('innerHeight')) - 25);
    assert.deepEqual(page.errors, []);
  });
});

test('containment checks bound work on a large inserted subtree', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await install(page);
  const result = await page.evaluate(`(async () => {
    const styles = getComputedStyle; let reads = 0;
    window.getComputedStyle = (...args) => {reads++; return styles(...args);};
    const bar = document.createElement('div'); bar.setAttribute('role', 'toolbar');
    bar.innerHTML = '<span>Control</span>'.repeat(5000);
    document.querySelector('article').append(bar);
    await new Promise(resolve => queueMicrotask(resolve));
    const count = reads; window.getComputedStyle = styles;
    return {reads: count, visibility: styles(document.querySelector('[aria-label="Conversation"]')).contentVisibility};
  })()`);
  assert(result.reads < 280, JSON.stringify(result));
  assert.equal(result.visibility, 'visible');
  assert.deepEqual(page.errors, []);
});

test('containment validation yields to interaction after indexing and cancels on close', async (t) => {
  for (const event of ['wheel', 'pointermove']) await t.test(event, async (t) => {
    const page = await browser(t, longChatHtml(20));
    if (!page) return;
    await page.evaluate(`(() => {
      const timeout = setTimeout;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 0 && callback.name === 'batch') {window.runContainment = callback; return 1000000;}
        return timeout(callback, delay, ...args);
      };
    })()`);
    await install(page, false, false);
    const count = await page.evaluate(`(() => {
      let reads = 0; const styles = getComputedStyle;
      window.getComputedStyle = (...args) => {reads++; return styles(...args);};
      document.querySelector('article').dispatchEvent(new ${event === 'wheel' ? 'WheelEvent' : 'PointerEvent'}('${event}', {bubbles: true}));
      runContainment();
      window.getComputedStyle = styles;
      return reads;
    })()`);
    assert.equal(count, 0, 'no validation style reads during interaction');
    await page.evaluate('panel.querySelector(".close").click()');
    assert.equal(await page.evaluate('document.querySelector("#sonora-chatgpt-visibility")'), null);
    assert.equal(await page.evaluate('document.querySelector("[data-sonora-containment]")'), null);
    assert.deepEqual(page.errors, []);
  });
});

test('a removed validation cursor cannot approve an unchecked positioned control', async (t) => {
  const page = await browser(t, chat('turn'));
  if (!page) return;
  await page.evaluate(`(() => {
    const timeout = setTimeout, createWalker = document.createTreeWalker.bind(document);
    window.setTimeout = (callback, delay, ...args) => {
      if ((delay === 0 && callback.name === 'batch') || callback === window.runContainment) {window.runContainment = callback; return 1000000;}
      return timeout(callback, delay, ...args);
    };
    document.createTreeWalker = (...args) => {
      const walker = createWalker(...args);
      if (args[0].id === 'turns') window.validationWalker = walker;
      return walker;
    };
  })()`);
  await install(page, false, false);
  await page.evaluate(`(() => {
    const now = performance.now.bind(performance); let calls = 0;
    performance.now = () => now() + 1000 + calls++ * 4;
    runContainment(); performance.now = now;
    window.removedCursor = validationWalker.currentNode;
    if (removedCursor === document.querySelector('#turns')) throw new Error('validation did not advance');
    removedCursor.remove();
  })()`);
  await page.evaluate('runContainment()');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#turns")).contentVisibility'), 'visible');
  assert.deepEqual(page.errors, []);
});

test('review4 a native media error flushes status and transport behind a pending word frame', async (t) => {
  const page = await browser(t, '<main><article data-testid="conversation-turn-0"><p>Read this answer.</p></article></main>');
  if (!page) return;
  await install(page, true);
  await page.evaluate('document.querySelector("p").click()');
  await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
  assert.match(await page.evaluate('panel.querySelector(".status span").textContent'), /^Playing/);
  await page.evaluate(`(async () => {
    const raf = requestAnimationFrame, cancel = cancelAnimationFrame;
    window.heldFrames = new Map(); let id = 1000000;
    window.requestAnimationFrame = callback => {heldFrames.set(++id, callback); return id;};
    window.cancelAnimationFrame = id => {if (!heldFrames.delete(id)) cancel(id);};
    await new Promise(resolve => raf(() => raf(resolve)));
    window.releaseFrames = async () => {
      window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel;
      const frames = [...heldFrames.values()]; heldFrames.clear();
      frames.forEach(callback => raf(callback));
      await new Promise(resolve => raf(() => raf(resolve)));
    };
  })()`);
  assert(await page.evaluate('heldFrames.size > 0'));
  const code = await page.evaluate(`new Promise(resolve => {
    const audio = panel.querySelector('audio');
    audio.addEventListener('error', () => resolve(audio.error.code), {once: true});
    audio.src = 'data:audio/wav;base64,AA=='; audio.load();
  })`);
  assert.equal(code, 4, 'exercise Chromium MediaError rather than a synthetic error event');
  await page.evaluate('releaseFrames()');
  assert.equal(await page.evaluate('panel.querySelector(".status span").textContent'), 'Sonora audio could not be decoded by this browser.');
  assert.equal(await page.evaluate('panel.querySelector(".play-label").textContent'), 'Resume');
  assert.equal(await page.evaluate('panel.querySelector(".play").classList.contains("is-playing")'), false);
  assert.deepEqual(page.errors, []);
});
