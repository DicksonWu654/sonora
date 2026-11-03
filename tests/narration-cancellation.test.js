const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const tick = () => new Promise(resolve => setImmediate(resolve));

function backend(t, { ready = true, readyTimeoutMs = 120000 } = {}) {
  const requests = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
  child.stdin.write = value => requests.push(JSON.parse(value));
  child.kill = () => child.emit('exit', 0);
  const context = { __dirname, module: { exports: {} }, setTimeout, clearTimeout, Buffer, process, require(name) {
    if (name === './config') return { python: 'fixture', modelDir: '/fixture', cacheDir: '/fixture', voices: [{ id: 'af_heart' }] };
    if (name === 'fs') return { existsSync: () => true, promises: { readFile: async () => { throw new Error('no cache'); } } };
    if (name === 'child_process') return { spawn: () => child };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../tools/narration/backend'), 'utf8'), context);
  const narration = context.module.exports.createNarrationBackend({ readyTimeoutMs });
  const makeReady = () => child.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
  if (ready) makeReady();
  t.after(() => narration.close());
  function complete(request, value = request.text) { child.stdout.write(JSON.stringify({ id: request.id, result: { text: value } }) + '\n'); }
  return { narration, requests, complete, makeReady, child };
}

test('abandoned queued renders never reach Kokoro while the newest selection proceeds', async t => {
  const { narration, requests, complete } = backend(t);
  const running = narration.generate('Already running', 'af_heart');
  await tick();
  for (let index = 0; index < 12; index++) {
    const controller = new AbortController();
    const stale = narration.generate(`Skipped ${index}`, 'af_heart', { signal: controller.signal });
    const rejected = assert.rejects(stale, /skip/);
    await tick();
    controller.abort(new Error('skip'));
    await rejected;
  }
  assert.equal(requests.length, 1, 'only the current inference enters the worker pipe');
  const latest = narration.generate('Newest selection', 'af_heart');
  await tick();
  complete(requests[0]);
  assert.equal((await running).text, 'Already running');
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].text, 'Newest selection');
  complete(requests[1]);
  assert.equal((await latest).text, 'Newest selection');
});

test('cancelling a reader preserves a shared render still needed by a book', async t => {
  const { narration, requests, complete } = backend(t);
  const active = narration.generate('Active', 'af_heart');
  const controller = new AbortController();
  const reader = narration.generate('Shared passage', 'af_heart', { signal: controller.signal });
  const book = narration.generate('Shared passage', 'af_heart');
  const rejected = assert.rejects(reader, /reader stopped/);
  await tick();
  controller.abort(new Error('reader stopped'));
  await rejected;
  complete(requests[0]);
  await active;
  await tick();
  assert.equal(requests[1].text, 'Shared passage');
  complete(requests[1]);
  assert.equal((await book).text, 'Shared passage');
});


test('renders submitted while the worker loads wait for readiness and then synthesize', async t => {
  const { narration, requests, complete, makeReady } = backend(t, { ready: false });
  const first = narration.generate('Opening while loading', 'af_heart');
  await tick();
  assert.equal(requests.length, 0);
  assert.equal(narration.status().state, 'loading');
  makeReady();
  await tick();
  assert.equal(requests.length, 1);
  complete(requests[0]);
  assert.equal((await first).text, 'Opening while loading');
});

test('waiting for readiness supports cancellation, a deadline and worker failure', async t => {
  const { narration, requests, makeReady } = backend(t, { ready: false, readyTimeoutMs: 30 });
  const controller = new AbortController();
  const cancelled = assert.rejects(narration.generate('Cancelled during loading', 'af_heart', { signal: controller.signal }), /stopped/);
  await tick(); controller.abort(new Error('stopped')); await cancelled;
  await assert.rejects(narration.generate('Deadline during loading', 'af_heart'), /did not become ready in time/);
  makeReady(); await tick();
  assert.equal(requests.length, 0, 'cancelled and expired waiters must never synthesize');
  const failed = backend(t, { ready: false });
  const rejected = assert.rejects(failed.narration.generate('Worker fails during loading', 'af_heart'), /stopped while warming up/);
  await tick(); failed.child.emit('exit', 1); await rejected;
});
