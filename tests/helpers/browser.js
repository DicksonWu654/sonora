const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function chromiumPath() {
  if (process.env.SONORA_CHROMIUM) return process.env.SONORA_CHROMIUM;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(cache)) return null;
  for (const name of fs.readdirSync(cache).filter(name => /^chromium-/.test(name)).sort().reverse()) {
    for (const suffix of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const binary = path.join(cache, name, suffix);
      if (fs.existsSync(binary)) return binary;
    }
  }
  return null;
}

// CDP keeps the DOM regressions dependency-free, like the rest of npm test.
async function browser(t, html, url = 'https://chatgpt.com/c/synthetic', options = {}) {
  const binary = chromiumPath();
  if (!binary) { t.skip('Set SONORA_CHROMIUM or install Playwright Chromium to run DOM checks.'); return null; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-dom-'));
  const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...options.args || [], 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port;
  for (let attempt = 0; !port; attempt++) {
    if (attempt > 150 || child.exitCode !== null) throw new Error('Chromium did not start.');
    if (fs.existsSync(portFile)) {
      // Chrome creates the file before writing its port and browser endpoint.
      const [candidate, endpoint] = fs.readFileSync(portFile, 'utf8').split('\n');
      if (/^\d+$/.test(candidate) && Number(candidate) > 0 && Number(candidate) <= 65535 && endpoint?.startsWith('/devtools/browser/')) port = candidate;
    }
    if (!port) await new Promise(resolve => setTimeout(resolve, 20));
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  t.after(() => socket.close());
  let sequence = 0;
  const pending = new Map(), listeners = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    } else listeners.get(message.method)?.(message.params);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  listeners.set('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  await send('Runtime.enable');
  await send('Page.enable');
  listeners.set('Fetch.requestPaused', event => {
    send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(html).toString('base64') }).catch(() => {});
  });
  if (!options.network) await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.navigate', { url });
  for (let attempt = 0; await evaluate('document.readyState') !== 'complete'; attempt++) {
    if (attempt > 100) throw new Error('Synthetic page did not load.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { evaluate, send, errors, port };
}

function longChatHtml(count = 500) {
  return `<!doctype html><meta charset="utf-8"><title>Synthetic chat</title><style>
    body { margin: 20px; } pre { padding: 10px; background: #eee; } code { white-space: pre; font: 14px/20px monospace; }
    .transparent { opacity: 0; }
    </style><main><div role="region" aria-label="Conversation">${Array.from({ length: count }, (_, index) => `
    <article data-testid="conversation-turn-${index}"><div data-message-id="message-${index}">
    <p>Turn ${index} says <code>answer()</code> aloud.<span class="transparent">Invisible label</span></p>
    ${index % 5 === 0 ? `<pre><div class="header"><span>javascript</span><button>Copy code</button><button>Edit</button></div><div><code>${Array.from({ length: 5 }, (_, line) => `<span>const</span> value${line} = <span>${index + line}</span>;`).join('\n')}</code></div></pre>` : ''}
    </div></article>`).join('')}</div></main>`;
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

module.exports = { browser, longChatHtml, waitFor };
