const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { browser, waitFor } = require('./helpers/browser');
const validation = require('../extension/validation');

function background({ top, children = [], granted = true }) {
  let action, receive;
  const scripts = [], probes = [], opened = [], notices = [];
  const context = {
    SonoraValidation: validation, URL, URLSearchParams, console, AbortController,
    setTimeout, clearTimeout, fetch: async () => ({json: async () => ({ready: true})}),
    chrome: {
      runtime: {id: 'sonora', getManifest: () => ({version: 'test'}), getURL: file => 'chrome-extension://sonora/' + file,
        onInstalled: {addListener() {}}, onStartup: {addListener() {}}, onMessage: {addListener(fn) {receive = fn;}}},
      contextMenus: {removeAll(fn) {fn();}, create(options, fn) {fn();}, onClicked: {addListener() {}}},
      action: {onClicked: {addListener(fn) {action = fn;}}},
      storage: {local: {get: async () => ({})}},
      permissions: {contains: async () => granted},
      webNavigation: {getAllFrames: async () => [{frameId: 0, parentFrameId: -1, url: 'https://parent.test/page'},
        ...(top.frames || []).map((frame, index) => ({frameId: children.find(item => item.result.path.join('/') === frame.path.join('/'))?.frameId || index + 1,
          parentFrameId: 0, url: frame.url}))]},
      tabs: {create: async options => {opened.push(options);}, get: async id => ({id, url: 'https://parent.test/page'})},
      scripting: {removeCSS: async () => {}, insertCSS: async () => {}, async executeScript(options) {
        if (options.func?.name === 'probeFrame') {
          probes.push(options.target);
          return options.target.allFrames ? [{frameId: 0, result: top}, ...children] : [{frameId: 0, result: top}];
        }
        if (options.files) scripts.push(options.target);
        if (options.args?.[1]) notices.push(options.args[1]);
        return [{result: false}];
      }}
    }
  };
  const framesFile = require.resolve('../extension/background.js').replace('background.js', 'frames.js');
  if (fs.existsSync(framesFile)) context.SonoraFrames = require(framesFile);
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8').replace(/^import .*;$/gm, ''), context);
  return {scripts, probes, opened, notices, action: () => action({id: 1, url: 'https://parent.test/page'}),
    denied: () => new Promise(resolve => receive({type: 'sonora-frame-access', granted: false}, {id: 'sonora', url: opened[0].url}, resolve))};
}
const embed = (index, area, url = 'https://embed.test/doc') => ({path: [index], area, url});
const frame = (id, index, score = 500) => ({frameId: id, result: {path: [index], readable: true, score, frames: []}});

test('toolbar selects the largest visible readable iframe when the top frame has only chrome', async () => {
  const bridge = background({top: {path: [], readable: false, score: 0, frames: [embed(0, 50000), embed(1, 300000)]}, children: [frame(7, 0), frame(12, 1)]});
  await bridge.action();
  assert.equal(bridge.scripts[0].frameIds?.[0], 12);
  assert.equal(bridge.opened.length, 0);
});

test('a readable top frame skips all subframe probes and permission work', async () => {
  const bridge = background({top: {path: [], readable: true, score: 500, frames: []}, children: [frame(12, 0)]});
  await bridge.action();
  assert.equal(bridge.probes.length, 1);
  assert.equal(bridge.probes.some(probe => probe.allFrames), false);
  assert.equal(bridge.opened.length, 0);
  assert.equal(bridge.scripts[0].frameIds?.[0] || 0, 0);
});

test('hidden frames are excluded and a visible nested document can be selected', async () => {
  const top = {path: [], readable: false, score: 0, frames: [embed(0, 500000)]};
  const bridge = background({top, children: [frame(8, 1), {frameId: 7, result: {path: [0], readable: false, score: 0, frames: [{path: [0, 0], area: 400000, url: 'https://embed.test/nested'}]}}, {frameId: 9, result: {path: [0, 0], readable: true, score: 1000, frames: []}}]});
  await bridge.action();
  assert.equal(bridge.scripts[0].frameIds?.[0], 9);
});

test('inaccessible embedded text opens a site-specific permission page and denial is explained in the panel', async () => {
  const bridge = background({top: {path: [], readable: false, score: 0, frames: [embed(0, 300000)]}, granted: false});
  await bridge.action();
  assert.equal(bridge.opened.length, 1);
  const prompt = new URL(bridge.opened[0].url);
  assert.equal(prompt.pathname, '/frame-permission.html');
  assert.equal(prompt.searchParams.get('origin'), 'https://embed.test/*');
  await bridge.denied();
  assert(bridge.notices.some(message => /permission.*denied/i.test(message) && /embed.test/.test(message)));
});

test('the overlay explains denied frame access instead of reporting zero clickable blocks', async t => {
  const page = await browser(t, '<main><div id="frame-placeholder"></div></main>', 'https://parent.test/page');
  if (!page) return;
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {const shadow = attach.call(this, options); if (this.id === 'sonora-overlay-root') window.panel = shadow; return shadow;};
    window.__sonoraFrameNotice = 'Frame permission was denied for embed.test. Embedded text cannot be read until you allow access.';
    window.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}, runtime: {onMessage: {addListener() {}, removeListener() {}}, sendMessage(message, fn) {fn({ok: true, data: {ready: true}});}}};
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js']) await page.evaluate(fs.readFileSync(require.resolve('../extension/' + file), 'utf8'));
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('denied')`);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /permission.*denied/i);
  assert.doesNotMatch(await page.evaluate(`panel.querySelector('.meta').textContent`), /0 clickable blocks/);
  assert.deepEqual(page.errors, []);
});

test('frame probes sample huge text once and never inspect ChatGPT or Google Docs subframes', async t => {
  const {probeFrame} = require('../extension/frames');
  for (const [url, html, special] of [
    ['https://article.test/large', '<main><p>' + 'word '.repeat(50000) + '</p><iframe src="https://embed.test/"></iframe></main>', false],
    ['https://chatgpt.com/c/large', '<main><article data-testid="conversation-turn-0"><p>Chat</p></article></main>', true],
    ['https://docs.google.com/document/d/example/edit', '<main class="kix-rotatingtilemanager">Canvas document</main>', true]
  ]) await t.test(url, async t => {
    const page = await browser(t, html, url); if (!page) return;
    const result = await page.evaluate(`(() => {
      let visits = 0, reads = 0;
      const create = document.createTreeWalker.bind(document);
      document.createTreeWalker = (...args) => {
        const walker = create(...args), next = walker.nextNode.bind(walker);
        walker.nextNode = () => {visits++; return next();}; return walker;
      };
      const descriptor = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data');
      Object.defineProperty(CharacterData.prototype, 'data', {...descriptor, get() {reads++; return descriptor.get.call(this);}});
      const result = (${probeFrame.toString()})();
      return {result, visits, reads};
    })()`);
    assert.equal(result.result.readable, true);
    assert.equal(result.result.frames.length, 0);
    assert(result.visits <= (special ? 0 : 4));
    assert.equal(result.reads, special ? 0 : 1);
    assert.deepEqual(page.errors, []);
  });
});

test('known-site shells without a conversation or Docs canvas still inspect their embedded documents', async t => {
  const {probeFrame} = require('../extension/frames');
  for (const url of ['https://chatgpt.com/c/embedded', 'https://docs.google.com/document/d/embedded/edit']) await t.test(url, async t => {
    const page = await browser(t, '<main><iframe srcdoc="<p>Embedded document.</p>"></iframe></main>', url);
    if (!page) return;
    const result = await page.evaluate(`(${probeFrame.toString()})()`);
    assert.equal(result.readable, false);
    assert.equal(result.frames.length, 1);
    assert.deepEqual(result.frames[0].path, [0]);
  });
});
