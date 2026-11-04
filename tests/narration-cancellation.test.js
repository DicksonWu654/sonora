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
  const context = { __dirname, module: { exports: {} }, setTimeout, clearTimeout, Buffer, URL, AbortController, process, require(name) {
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
  const { narration, requests, makeReady } = backend(t, { ready: false });
  const controller = new AbortController();
  const cancelled = assert.rejects(narration.generate('Cancelled during loading', 'af_heart', { signal: controller.signal }), /stopped/);
  await tick(); controller.abort(new Error('stopped')); await cancelled;
  const deadline = backend(t, { ready: false, readyTimeoutMs: 30 });
  await assert.rejects(deadline.narration.generate('Deadline during loading', 'af_heart'), /did not become ready in time/);
  deadline.makeReady();
  makeReady(); await tick();
  assert.equal(requests.length, 0, 'cancelled and expired waiters must never synthesize');
  assert.equal(deadline.requests.length, 0);
  const failed = backend(t, { ready: false });
  const rejected = assert.rejects(failed.narration.generate('Worker fails during loading', 'af_heart'), /stopped while warming up/);
  await tick(); failed.child.emit('exit', 1); await rejected;
});

test('supervisor cancellation drops a queued render before the worker sees it', {timeout: 5000}, async t => {
  const http = require('node:http');
  const { createSupervisor } = require('../tools/supervisor');
  const { narration, requests, complete } = backend(t);
  let bodyReceived = false, responseClosed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/narration/render') {
      req.once('end', () => { bodyReceived = true; });
      res.once('close', () => { responseClosed = true; });
    }
    narration.handle(req, res, req.url);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = new EventEmitter(); child.exitCode = null; child.killed = false;
  child.kill = () => { child.exitCode = 0; child.killed = true; child.emit('exit', 0); };
  const supervisor = createSupervisor({port: 0, backendPort: server.address().port, spawnBackend: () => child});
  await supervisor.listen();
  t.after(async () => { await supervisor.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const active = narration.generate('Active inference.', 'af_heart');
  await tick();
  const controller = new AbortController();
  const queued = fetch(`http://127.0.0.1:${supervisor.address().port}/api/narration/render`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({text: 'Cancelled queued passage.', voice: 'af_heart'}), signal: controller.signal
  });
  const cancelled = assert.rejects(queued, /reader stopped/);
  for (let attempt = 0; !bodyReceived && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(bodyReceived, 'the POST body must reach the real backend before cancelling');
  await tick(); await tick();
  controller.abort(new Error('reader stopped')); await cancelled;
  for (let attempt = 0; !responseClosed && attempt < 40; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  complete(requests[0]); await active;
  await tick(); await tick();
  const spoken = requests.map(request => request.text);
  // Finish a wrongly dispatched request as well, so a failing reproduction cleans up.
  if (requests[1]) { complete(requests[1]); await tick(); }
  assert.deepEqual(spoken, ['Active inference.']);
});
