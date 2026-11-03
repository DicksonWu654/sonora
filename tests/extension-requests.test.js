const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const validation = require('../extension/validation');
const tick = () => new Promise(resolve => setImmediate(resolve));

function background(fetch, get = async () => ({})) {
  let receive;
  const timers = new Set();
  const chrome = {
    runtime: { id: 'sonora', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { receive = fn; } } },
    contextMenus: { removeAll(callback) { callback(); }, create(options, callback) { callback(); }, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } }, storage: { local: { get } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8').replace("import './validation.js';", ''), {
    chrome, SonoraValidation: validation, fetch, AbortController, Uint8Array, btoa, console,
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); }
  });
  return {
    send(message) { return new Promise(resolve => receive(message, { id: 'sonora', tab: { id: 1 }, documentId: 'one' }, resolve)); },
    timeout() { for (const fn of [...timers]) fn(); }, timers
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
