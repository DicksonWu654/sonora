const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { createSupervisor, DEFAULT_IDLE_MS } = require('../tools/supervisor');

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function fakeChild(onKill) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = signal => {
    child.killed = true;
    onKill(signal);
    child.exitCode = signal === 'SIGKILL' ? 137 : 0;
    child.emit('exit', child.exitCode, signal);
    return true;
  };
  return child;
}

async function waitFor(condition, timeout = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for supervisor state.');
}

test('supervisor starts on demand, proxies requests, and preserves active book jobs', async t => {
  let jobs = [];
  let starts = 0;
  let kills = 0;
  const backendServer = http.createServer((req, res) => {
    if (req.url === '/api/narration/status') return json(res, 200, { ready: true, state: 'ready' });
    if (req.url === '/api/books') return json(res, 200, { jobs });
    if (req.url === '/echo') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => json(res, 200, { body, origin: req.headers.origin || null }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => backendServer.listen(0, '127.0.0.1', resolve));
  const backend = backendServer.address().port;
  t.after(() => backendServer.close());

  const supervisor = createSupervisor({
    port: 0,
    backendPort: backend,
    idleMs: 40,
    activeJobCheckMs: 20,
    spawnBackend: () => {
      starts++;
      return fakeChild(() => { kills++; backendServer.close(); });
    }
  });
  await supervisor.listen();
  t.after(() => supervisor.close());
  const address = supervisor.address();
  const url = address ? `http://127.0.0.1:${address.port}` : null;
  assert(url, 'supervisor should expose its listening address for tests');

  const response = await fetch(`${url}/echo`, {
    method: 'POST',
    headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    body: 'hello'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { body: 'hello', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
  assert.equal(starts, 1);

  jobs = [{ state: 'rendering' }];
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(kills, 0, 'active conversions must keep the backend alive');
  assert.equal(supervisor.state().backendRunning, true);

  jobs = [];
  await waitFor(() => kills === 1);
  assert.equal(supervisor.state().backendRunning, false);
  assert.equal(starts, 1);
  await supervisor.close();
});


test('the one-hour idle default remains configurable', async () => {
  assert.equal(DEFAULT_IDLE_MS, 3600000);
  const supervisor = createSupervisor({port: 0, backendPort: 12345, idleMs: 1234});
  assert.equal(supervisor.state().idleMs, 1234);
  await supervisor.close();
});


test('disconnecting a reader cancels a proxied render even after its request body was sent', async t => {
  let renderStarted, renderClosed;
  const started = new Promise(resolve => { renderStarted = resolve; });
  const closed = new Promise(resolve => { renderClosed = resolve; });
  const backendServer = http.createServer((req, res) => {
    if (req.url === '/api/narration/status') return json(res, 200, {ready: true});
    if (req.url === '/api/narration/render') {
      req.resume();
      req.on('end', renderStarted);
      res.on('close', renderClosed);
    }
  });
  await new Promise(resolve => backendServer.listen(0, '127.0.0.1', resolve));
  const supervisor = createSupervisor({port: 0, backendPort: backendServer.address().port, spawnBackend: () => fakeChild(() => {})});
  await supervisor.listen();
  t.after(async () => { await supervisor.close(); backendServer.closeAllConnections(); await new Promise(resolve => backendServer.close(resolve)); });
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${supervisor.address().port}/api/narration/render`, {method: 'POST', body: '{}', signal: controller.signal});
  const cancelled = assert.rejects(request, /stopped/);
  await started;
  controller.abort(new Error('reader stopped'));
  await cancelled;
  await Promise.race([closed, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Upstream render was not cancelled')), 1000); timer.unref(); })]);
  await waitFor(() => supervisor.state().activeRequests === 0);
});


test('parallel prewarm and overlay requests both await the same backend startup', async t => {
  let releaseStatus, starts = 0;
  const backendServer = http.createServer((req, res) => { releaseStatus = () => json(res, 200, {ready: false, state: 'loading'}); });
  await new Promise(resolve => backendServer.listen(0, '127.0.0.1', resolve));
  const supervisor = createSupervisor({port: 0, backendPort: backendServer.address().port, spawnBackend: () => { starts++; return fakeChild(() => {}); }});
  t.after(async () => { await supervisor.close(); backendServer.closeAllConnections(); await new Promise(resolve => backendServer.close(resolve)); });
  const first = supervisor.ensureBackend();
  let secondFinished = false;
  const second = supervisor.ensureBackend().then(() => { secondFinished = true; });
  await waitFor(() => Boolean(releaseStatus));
  assert.equal(secondFinished, false, 'a spawned child is not necessarily listening yet');
  releaseStatus(); await Promise.all([first, second]);
  assert.equal(starts, 1);
});
