const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { after } = require('node:test');

function chromiumPath() {
  if (process.env.SONORA_CHROMIUM) return process.env.SONORA_CHROMIUM;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(cache)) return null;
  for (const name of fs
    .readdirSync(cache)
    .filter((name) => /^chromium-/.test(name))
    .sort()
    .reverse()) {
    for (const suffix of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const binary = path.join(cache, name, suffix);
      if (fs.existsSync(binary)) return binary;
    }
  }
  return null;
}
function extensionArgs() {
  const extension = path.resolve(__dirname, '../../extension');
  return [
    '--enable-unsafe-extension-debugging',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,1000',
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`
  ];
}
async function connection(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map(),
    listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    } else listeners.get(message.method)?.(message.params);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('Browser target closed.'));
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Browser target closed.'));
        return;
      }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate, listeners, close: () => socket.close() };
}

// Node isolates test files in separate processes. Each file owns exactly one
// Chromium process; cases get fresh pages (and fresh contexts for DOM doubles).
let session;
async function launch(args) {
  const binary = chromiumPath();
  if (!binary) throw new Error('Set SONORA_CHROMIUM or install Playwright Chromium.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-tests-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      ...args,
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  child.stderr.on('data', () => {});
  if (process.env.SONORA_TEST_METRICS)
    fs.appendFileSync(
      process.env.SONORA_TEST_METRICS,
      JSON.stringify({ type: 'browser', pid: child.pid, file: process.argv[1] }) + '\n'
    );
  const stop = async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  try {
    const deadline = Date.now() + 10000,
      portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    while (!port) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Chromium did not start.');
      if (fs.existsSync(portFile)) {
        const [value, endpoint] = fs.readFileSync(portFile, 'utf8').split('\n');
        if (/^\d+$/.test(value) && endpoint?.startsWith('/devtools/browser/')) port = value;
      }
      if (!port) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const root = await connection(version.webSocketDebuggerUrl);
    const original = (await root.send('Target.getTargets')).targetInfos
      .filter((item) => item.type === 'page')
      .map((item) => item.targetId);
    return {
      port,
      root,
      args,
      original,
      stop: async () => {
        root.close();
        await stop();
      }
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
if (process.env.NODE_TEST_CONTEXT)
  after(async () => {
    if (session) await (await session).stop();
  });

async function browser(t, html, url = 'https://chatgpt.com/c/synthetic', options = {}) {
  if (!chromiumPath()) {
    t.skip('Playwright Chromium is unavailable.');
    return null;
  }
  session ||= launch(options.args || []);
  const shared = await session;
  if (options.args && JSON.stringify(options.args) !== JSON.stringify(shared.args))
    throw new Error('Use the same browser arguments throughout a feature file.');
  const native = shared.args.some((arg) => arg.startsWith('--load-extension='));
  const existing = new Set((await shared.root.send('Target.getTargets')).targetInfos.map((item) => item.targetId));
  const context = native ? null : (await shared.root.send('Target.createBrowserContext')).browserContextId;
  const created = await shared.root.send('Target.createTarget', {
    url: 'about:blank',
    ...(context ? { browserContextId: context } : {})
  });
  const targets = await (await fetch(`http://127.0.0.1:${shared.port}/json`)).json();
  const page = await connection(targets.find((item) => item.id === created.targetId).webSocketDebuggerUrl);
  t.after(async () => {
    page.close();
    if (context) await shared.root.send('Target.disposeBrowserContext', { browserContextId: context });
    else {
      const targets = (await shared.root.send('Target.getTargets')).targetInfos;
      for (const item of targets)
        if (item.type === 'page' && !existing.has(item.targetId))
          await shared.root.send('Target.closeTarget', { targetId: item.targetId }).catch(() => {});
    }
  });
  const errors = [];
  page.listeners.set('Runtime.exceptionThrown', (event) =>
    errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text)
  );
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  let content = html;
  page.listeners.set('Fetch.requestPaused', (event) => {
    page
      .send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(content || '').toString('base64')
      })
      .catch(() => {});
  });
  async function setContent(value, address = url, intercept = true, allRequests = false) {
    content = value;
    if (intercept)
      await page.send('Fetch.enable', { patterns: [{ urlPattern: allRequests ? '*' : address.split('#')[0] }] });
    else await page.send('Fetch.disable');
    await page.send('Page.navigate', { url: address });
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        if (await page.evaluate(`location.href===${JSON.stringify(address)}&&document.readyState==='complete'`)) break;
      } catch (error) {
        if (!/context|Execution/.test(error.message)) throw error;
      }
      if (Date.now() > deadline) throw new Error('Synthetic page did not load.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await setContent(html, url, !options.network, !options.network);
  return { ...page, errors, port: shared.port, setContent };
}

function longChatHtml(count = 500) {
  return `<!doctype html><meta charset="utf-8"><title>Synthetic chat</title><style>
    body { margin: 20px; } pre { padding: 10px; background: #eee; } code { white-space: pre; font: 14px/20px monospace; }
    .transparent { opacity: 0; }
    </style><main><div role="region" aria-label="Conversation">${Array.from(
      { length: count },
      (_, index) => `
    <article data-testid="conversation-turn-${index}"><div data-message-id="message-${index}">
    <p>Turn ${index} says <code>answer()</code> aloud.<span class="transparent">Invisible label</span></p>
    ${index % 5 === 0 ? `<pre><div class="header"><span>javascript</span><button>Copy code</button><button>Edit</button></div><div><code>${Array.from({ length: 5 }, (_, line) => `<span>const</span> value${line} = <span>${index + line}</span>;`).join('\n')}</code></div></pre>` : ''}
    </div></article>`
    ).join('')}</div></main>`;
}

async function waitFor(page, expression, timeout = 10000) {
  await page.evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    async function check() {
      try {
        if (await (${expression})) { resolve(); return; }
        if (performance.now() - started > ${timeout}) throw new Error(${JSON.stringify('Timed out waiting for: ' + expression)});
        if (globalThis.requestAnimationFrame) requestAnimationFrame(check);
        else setTimeout(check, 20);
      } catch (error) { reject(error); }
    }
    check();
  })`);
}

module.exports = { browser, longChatHtml, waitFor, chromiumPath, extensionArgs };
