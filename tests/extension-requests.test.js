const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const validation = require('../extension/validation');
const tick = () => new Promise(resolve => setImmediate(resolve));

function background(fetch, get = async () => ({})) {
  let receive, action;
  const notices = [], injections = [];
  const timers = new Set();
  const chrome = {
    runtime: { id: 'sonora', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { receive = fn; } } },
    contextMenus: { removeAll(callback) { callback(); }, create(options, callback) { callback(); }, onClicked: { addListener() {} } },
    scripting: { async insertCSS() { injections.push('css'); }, async executeScript() { injections.push('scripts'); } },
    tabs: { async sendMessage(tabId, message) { notices.push(message); } },
    action: { onClicked: { addListener(fn) { action = fn; } } }, storage: { local: { get } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8').replace("import './validation.js';", ''), {
    chrome, SonoraValidation: validation, fetch, AbortController, Uint8Array, btoa, console,
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); }
  });
  return {
    send(message) { return new Promise(resolve => receive(message, { id: 'sonora', tab: { id: 1 }, documentId: 'one' }, resolve)); },
    timeout() { for (const fn of [...timers]) fn(); }, timers, notices, injections, action: tab => action(tab)
  };
}

function untilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('render cancellation cannot be overtaken by the asynchronous server setting lookup', async () => {
  let release, fetches = 0;
  const bridge = background(() => { fetches++; }, () => new Promise(resolve => { release = resolve; }));
  const rendered = bridge.send({ type: 'sonora-render', requestId: 'one', text: 'Read this.' });
  await bridge.send({ type: 'sonora-cancel-render', requestId: 'one' });
  release({});
  assert.match((await rendered).error, /cancelled/);
  await tick();
  assert.equal(fetches, 0);
  assert.equal(bridge.timers.size, 0);
});

test('stop aborts a render already fetching and timeouts include reading the response body', async () => {
  let currentSignal;
  const bridge = background(async (url, { signal }) => {
    currentSignal = signal;
    return { ok: true, json: () => untilAbort(signal) };
  });
  const first = bridge.send({ type: 'sonora-render', requestId: 'first', text: 'Read this.' });
  await tick();
  await bridge.send({ type: 'sonora-cancel-render', requestId: 'first' });
  assert(currentSignal.aborted);
  assert.match((await first).error, /cancelled/);
  const second = bridge.send({ type: 'sonora-render', requestId: 'second', text: 'Another passage.' });
  await tick();
  bridge.timeout();
  assert.match((await second).error, /timed out/);
  await tick();
  assert.equal(bridge.timers.size, 0);
});

test('audio downloads remain covered by render cancellation', async () => {
  let audioSignal;
  const bridge = background(async (url, { signal }) => String(url).endsWith('/render')
    ? { ok: true, json: async () => ({ audioUrl: '/api/narration/audio/' + 'a'.repeat(64) + '.wav' }) }
    : { ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer: () => { audioSignal = signal; return untilAbort(signal); } });
  const rendered = bridge.send({ type: 'sonora-render', requestId: 'audio', text: 'Read this.' });
  await tick();
  await bridge.send({ type: 'sonora-cancel-render', requestId: 'audio' });
  assert(audioSignal.aborted);
  assert.match((await rendered).error, /cancelled/);
});


test('toolbar prewarm runs alongside injection and synthesis metadata precedes the WAV body', async () => {
  let bodyStarted = false, metadataSeen = false;
  const bridge = background(async (url, { signal }) => {
    if (String(url).endsWith('/status')) return { json: async () => ({ ready: true }) };
    if (String(url).endsWith('/render')) return { ok: true, json: async () => ({ audioUrl: '/api/narration/audio/' + 'a'.repeat(64) + '.wav' }) };
    return { ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer() {
      bodyStarted = true; metadataSeen = bridge.notices.length > 0;
      return untilAbort(signal);
    } };
  });
  await bridge.action({ id: 1 });
  await tick();
  assert.deepEqual(bridge.injections, ['css', 'scripts']);
  assert.equal(bridge.timers.size, 0);
  const rendered = bridge.send({ type: 'sonora-render', requestId: 'early', text: 'Read this.' });
  await tick();
  assert(bodyStarted && metadataSeen);
  assert.equal(bridge.notices[0].type, 'sonora-render-ready');
  await bridge.send({ type: 'sonora-cancel-render', requestId: 'early' });
  assert.match((await rendered).error, /cancelled/);
});
