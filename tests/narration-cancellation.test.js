const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const tick = () => new Promise(resolve => setImmediate(resolve));

function backend(t) {
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
  const narration = context.module.exports.createNarrationBackend();
  child.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
  t.after(() => narration.close());
  function complete(request, value = request.text) { child.stdout.write(JSON.stringify({ id: request.id, result: { text: value } }) + '\n'); }
  return { narration, requests, complete };
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
