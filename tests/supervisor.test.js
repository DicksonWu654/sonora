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
  let jobChecks = 0;
  const backendServer = http.createServer((req, res) => {
    if (req.url === '/api/narration/status') return json(res, 200, { ready: true, state: 'ready' });
    if (req.url === '/api/books') { jobChecks++; return json(res, 200, { jobs }); }
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
  // The first idle check is scheduled at least 1 s later. A second job query
  // proves the first check completed and kept the active conversion alive.
  await waitFor(() => jobChecks > 1, 10000);
  assert.equal(kills, 0, 'active conversions must keep the backend alive');
  assert.equal(supervisor.state().backendRunning, true);

  jobs = [];
  await waitFor(() => kills === 1, 10000);
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

test('idle library polling neither renews activity nor restarts a sleeping backend (audit 21)', {timeout: 10000}, async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout']});
  let starts = 0, kills = 0;
  let stopped;
  const idleStopped = new Promise(resolve => { stopped = resolve; });
  const backendServer = http.createServer((req, res) => json(res, 200,
    req.url.startsWith('/api/books') ? {jobs: []} : {ready: true}));
  await new Promise(resolve => backendServer.listen(0, '127.0.0.1', resolve));
  const supervisor = createSupervisor({port: 0, backendPort: backendServer.address().port, idleMs: 80,
    spawnBackend: () => { starts++; return fakeChild(() => { kills++; stopped(); }); }});
  await supervisor.listen();
  t.after(async () => {
    await supervisor.close(); backendServer.closeAllConnections();
    await new Promise(resolve => backendServer.close(resolve));
  });
  const url = `http://127.0.0.1:${supervisor.address().port}`;
  await (await fetch(url + '/api/narration/status')).json();
  const activity = supervisor.state().lastActivityAt;
  t.mock.timers.tick(10);
  await (await fetch(url + '/api/books?poll=1')).json();
  assert.equal(supervisor.state().lastActivityAt, activity, 'passive GET must not extend the configured idle window');
  // Complete each poll before advancing the idle clock. Overlapping network
  // requests test active-request protection, not passive keep-warm behavior.
  for (let at = 0; at < 3; at++) {
    t.mock.timers.tick(10);
    await (await fetch(url + '/api/books')).json();
    assert.equal(supervisor.state().lastActivityAt, activity);
  }
  assert.equal(supervisor.state().activeRequests, 0);
  t.mock.timers.tick(1000);
  await idleStopped;
  assert.equal(kills, 1);
  await (await fetch(url + '/api/books')).json();
  assert.equal(starts, 1, 'polling a sleeping backend must not wake it');
});

test('real reader use renews the owner-configured 24-hour keep-warm window', async t => {
  const previous = process.env.SONORA_IDLE_MS;
  process.env.SONORA_IDLE_MS = String(24 * 60 * 60 * 1000);
  t.after(() => { if (previous === undefined) delete process.env.SONORA_IDLE_MS; else process.env.SONORA_IDLE_MS = previous; });
  const backendServer = http.createServer((req, res) => { req.resume(); json(res, 200, {ready: true, jobs: []}); });
  await new Promise(resolve => backendServer.listen(0, '127.0.0.1', resolve));
  const supervisor = createSupervisor({port: 0, backendPort: backendServer.address().port, spawnBackend: () => fakeChild(() => {})});
  await supervisor.listen();
  t.after(async () => { await supervisor.close(); backendServer.closeAllConnections(); await new Promise(resolve => backendServer.close(resolve)); });
  const url = `http://127.0.0.1:${supervisor.address().port}`;
  assert.equal(supervisor.state().idleMs, 86400000);
  for (const path of ['/api/narration/render', '/api/books', '/api/books/example/retry']) {
    const before = supervisor.state().lastActivityAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    await fetch(url + path, {method: 'POST', body: '{}'});
    assert(supervisor.state().lastActivityAt > before, path + ' must renew keep-warm');
  }
  assert.equal(supervisor.state().backendRunning, true);
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
