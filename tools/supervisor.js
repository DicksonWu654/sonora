const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_BACKEND_PORT = 8788;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_ACTIVE_JOB_CHECK_MS = 30 * 1000;
const ACTIVE_JOB_STATES = new Set(['queued', 'rendering', 'encoding']);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(data);
}

function createSupervisor(options = {}) {
  const host = options.host || LOOPBACK;
  const port = options.port ?? positiveInteger(process.env.PORT, DEFAULT_PORT);
  const backendPort = options.backendPort ?? positiveInteger(process.env.SONORA_BACKEND_PORT, DEFAULT_BACKEND_PORT);
  const idleMs = options.idleMs ?? positiveInteger(process.env.SONORA_IDLE_MS, DEFAULT_IDLE_MS);
  const activeJobCheckMs = options.activeJobCheckMs ?? positiveInteger(process.env.SONORA_ACTIVE_JOB_CHECK_MS, DEFAULT_ACTIVE_JOB_CHECK_MS);
  if (backendPort === port) throw new Error('SONORA_BACKEND_PORT must differ from PORT.');
  const spawnBackend = options.spawnBackend || (childPort => spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(childPort) },
    stdio: 'inherit'
  }));

  let server = null;
  let backend = null;
  let startPromise = null;
  let stoppingPromise = null;
  let idleTimer = null;
  let lastActivityAt = Date.now();
  let activeRequests = 0;
  let closed = false;

  function scheduleIdleCheck(delay = Math.max(1000, idleMs - (Date.now() - lastActivityAt))) {
    clearTimeout(idleTimer);
    if (!backend || closed) return;
    idleTimer = setTimeout(checkIdle, Math.max(1, delay));
    idleTimer.unref?.();
  }

  function markActivity() {
    lastActivityAt = Date.now();
    scheduleIdleCheck();
  }

  function waitForBackend(child) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let timer;
      let settled = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.('exit', onExit);
        child.off?.('error', onError);
        error ? reject(error) : resolve();
      };
      const onExit = () => finish(new Error('Sonora server stopped while starting.'));
      const onError = error => finish(error);
      const retry = () => {
        if (settled) return;
        if (Date.now() - startedAt >= 15000) {
          finish(new Error('Sonora server did not start within 15 seconds.'));
          return;
        }
        const request = http.get({ host: LOOPBACK, port: backendPort, path: '/api/narration/status', headers: { host: `${LOOPBACK}:${backendPort}` } }, response => {
          response.resume();
          if (response.statusCode === 200) finish();
          else timer = setTimeout(retry, 100);
        });
        request.on('error', () => { timer = setTimeout(retry, 100); });
      };

      child.once?.('exit', onExit);
      child.once?.('error', onError);
      retry();
    });
  }

  async function ensureBackend() {
    if (stoppingPromise) await stoppingPromise;
    if (backend && backend.exitCode == null && !backend.killed) return;
    if (startPromise) return startPromise;

    const child = spawnBackend(backendPort);
    backend = child;
    child.once?.('exit', () => {
      if (backend === child) {
        backend = null;
        scheduleIdleCheck();
      }
    });
    startPromise = waitForBackend(child).catch(error => {
      if (backend === child) backend = null;
      try { child.kill(); } catch { /* The child may already be gone. */ }
      console.error(`Sonora server: ${error.message}`);
      throw error;
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function requestJson(pathname) {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: LOOPBACK, port: backendPort, path: pathname, headers: { host: `${LOOPBACK}:${backendPort}` } }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Sonora server returned ${response.statusCode}.`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Sonora server returned invalid JSON.')); }
        });
      });
      request.on('error', reject);
    });
  }

  async function hasActiveJobs() {
    try {
      const data = await requestJson('/api/books');
      return Array.isArray(data.jobs) && data.jobs.some(job => ACTIVE_JOB_STATES.has(job?.state));
    } catch (error) {
      // If the state check fails, leave the worker alive. A transient failure
      // must never interrupt a durable book conversion.
      console.error(`Sonora idle check: ${error.message}`);
      return true;
    }
  }

  async function stopBackend() {
    if (stoppingPromise) return stoppingPromise;
    const child = backend;
    if (!child) return;
    backend = null;
    clearTimeout(idleTimer);
    stoppingPromise = new Promise(resolve => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        child.off?.('exit', finish);
        resolve();
      };
      child.once?.('exit', finish);
      try { child.kill('SIGTERM'); }
      catch { finish(); return; }
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* The child may already be gone. */ }
        finish();
      }, 3000);
      timer.unref?.();
    }).finally(() => {
      stoppingPromise = null;
    });
    return stoppingPromise;
  }

  async function checkIdle() {
    idleTimer = null;
    if (!backend || closed) return;
    if (activeRequests > 0 || Date.now() - lastActivityAt < idleMs) {
      scheduleIdleCheck();
      return;
    }
    if (await hasActiveJobs()) {
      scheduleIdleCheck(activeJobCheckMs);
      return;
    }
    if (activeRequests === 0 && Date.now() - lastActivityAt >= idleMs) await stopBackend();
    else scheduleIdleCheck();
  }

  function forward(req, res) {
    return new Promise(resolve => {
      const headers = { ...req.headers, host: req.headers.host || `${host}:${port}` };
      const request = http.request({ host: LOOPBACK, port: backendPort, method: req.method, path: req.url, headers }, response => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
        response.on('end', resolve);
      });
      request.on('error', error => {
        if (!res.headersSent) json(res, 503, { error: 'Sonora is starting. Try again in a moment.' });
        else res.destroy();
        resolve();
        console.error(`Sonora proxy: ${error.message}`);
      });
      req.on('aborted', () => request.destroy());
      req.pipe(request);
    });
  }

  async function handle(req, res) {
    activeRequests++;
    markActivity();
    try {
      await ensureBackend();
      await forward(req, res);
    } catch (error) {
      req.resume();
      if (!res.headersSent) json(res, 503, { error: 'Sonora is starting. Try again in a moment.' });
      console.error(`Sonora supervisor: ${error.message}`);
    } finally {
      activeRequests--;
      scheduleIdleCheck();
    }
  }

  async function listen() {
    if (server) return server.address();
    server = http.createServer(handle);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    return server.address();
  }

  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    await stopBackend();
    if (server) await new Promise(resolve => server.close(resolve));
    server = null;
  }

  return { listen, close, ensureBackend, stopBackend, address: () => server?.address(), state: () => ({ activeRequests, backendRunning: Boolean(backend), lastActivityAt, idleMs }) };
}

if (require.main === module) {
  const supervisor = createSupervisor();
  supervisor.listen().then(address => {
    console.log(`Sonora supervisor listening at http://${address.address}:${address.port} (server starts on demand; idle timeout ${Math.round(supervisor.state().idleMs / 60000)} minutes)`);
  }).catch(error => {
    console.error(`Sonora supervisor: ${error.message}`);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    supervisor.close().then(() => process.exit(0));
  });
}

module.exports = { createSupervisor, DEFAULT_IDLE_MS };
