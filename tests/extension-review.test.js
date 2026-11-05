const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, longChatHtml, waitFor } = require('./helpers/browser');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function install(page) {
  await page.evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = attach.call(this, options);
      if (this.id === 'sonora-overlay-root') window.panel = shadow;
      return shadow;
    };
    window.messages = [];
    window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === 'sonora-status') callback({ok: true, data: {ready: true}});
        if (message.type === 'sonora-cancel-render') callback({ok: true});
      }
    }};
    window.AudioContext = class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } };
  })()`);
  for (const file of ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js']) {
    await page.evaluate(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'));
  }
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
}

const lastRender = `messages.findLast(message => message.type === 'sonora-render')?.text`;

test('same-ID turn replacement remains clickable for prose and code', async t => {
  const page = await browser(t, longChatHtml(2));
  if (!page) return;
  await install(page);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^3 clickable blocks/);
  await page.evaluate(`(() => {
    const previous = document.querySelector('article');
    const replacement = previous.cloneNode(true);
    replacement.querySelectorAll('.sonora-readable-block').forEach(node => node.classList.remove('sonora-readable-block', 'sonora-current-block', 'sonora-code-block'));
    replacement.querySelector('p').textContent = 'Replacement prose.';
    replacement.querySelector('code:not(p code)').textContent = 'replacement();';
    previous.replaceWith(replacement);
  })()`);
  await delay(220);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^3 clickable blocks/);
  await page.evaluate(`document.querySelector('article p').click()`);
  assert.equal(await page.evaluate(lastRender), 'Replacement prose.');
  await page.evaluate(`document.querySelector('pre').click()`);
  assert.equal(await page.evaluate(lastRender), 'replacement();');
  assert.deepEqual(page.errors, []);
});

test('reattached paragraphs narrate edits made while detached', async t => {
  const page = await browser(t, longChatHtml(2));
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    window.detached = document.querySelectorAll('article p')[1];
    window.destination = detached.parentElement;
    detached.remove();
  })()`);
  await delay(220);
  await page.evaluate(`detached.textContent = 'Edited while detached.'; destination.append(detached)`);
  await delay(220);
  await page.evaluate('detached.click()');
  assert.equal(await page.evaluate(lastRender), 'Edited while detached.');
  assert.deepEqual(page.errors, []);
});

test('previously excluded paragraphs become readable after growing', async t => {
  const page = await browser(t, '<main><p id="growing">A</p><p>Existing readable paragraph.</p></main>', 'https://example.test/article');
  if (!page) return;
  await install(page);
  assert.equal(await page.evaluate(`document.querySelector('#growing').classList.contains('sonora-readable-block')`), false);
  await page.evaluate(`document.querySelector('#growing').textContent = 'Now a complete readable sentence.'`);
  await delay(220);
  assert.equal(await page.evaluate(`document.querySelector('#growing').classList.contains('sonora-readable-block')`), true);
  await page.evaluate(`document.querySelector('#growing').click()`);
  assert.equal(await page.evaluate(lastRender), 'Now a complete readable sentence.');
  assert.deepEqual(page.errors, []);
});

test('clicking trailing code whitespace starts its visual line', async t => {
  const page = await browser(t, '<style>pre{padding:10px}code{display:block;white-space:pre;font:16px/24px monospace}</style><main><article data-testid="conversation-turn-0"><pre><code>alpha();\nbeta();\ngamma();</code></pre></article></main>');
  if (!page) return;
  await install(page);
  const bounds = await page.evaluate(`(() => { const r = document.querySelector('code').getBoundingClientRect(); return {x: r.left, y: r.top, width: r.width}; })()`);
  for (const [line, expected, trailing] of [[0, 'alpha();', true], [1, 'beta();', true], [2, 'gamma();', true], [1, 'beta();', false]]) {
    const before = await page.evaluate('messages.length');
    const point = { x: bounds.x + (trailing ? Math.min(200, bounds.width - 20) : 2), y: bounds.y + line * 24 + 12 };
    await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
    await waitFor(page, `messages.slice(${before}).some(message => message.type === 'sonora-render')`);
    assert.equal(await page.evaluate(lastRender), expected);
    await page.evaluate(`panel.querySelector('.stop').click()`);
  }
  await page.evaluate(`document.querySelector('code').textContent = 'alpha();   \\n    beta();\\n  gamma();'`);
  await delay(220);
  const before = await page.evaluate('messages.length');
  const indentation = { x: bounds.x + 2, y: bounds.y + 24 + 12 };
  await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...indentation});
  await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...indentation});
  await waitFor(page, `messages.slice(${before}).some(message => message.type === 'sonora-render')`);
  assert.equal(await page.evaluate(lastRender), 'beta();');
  assert.deepEqual(page.errors, []);
});

test('unscoped ChatGPT additions and streamed edits refresh the reader', async t => {
  const page = await browser(t, longChatHtml(2));
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'outside-turn'; paragraph.textContent = 'New unscoped prose';
    document.querySelector('[aria-label="Conversation"]').append(paragraph);
  })()`);
  await delay(220);
  assert.equal(await page.evaluate(`document.querySelector('#outside-turn').classList.contains('sonora-readable-block')`), true);
  await page.evaluate(`document.querySelector('#outside-turn').click()`);
  assert.equal(await page.evaluate(lastRender), 'New unscoped prose');
  await page.evaluate(`panel.querySelector('.stop').click(); document.querySelector('#outside-turn').firstChild.appendData(' with streamed suffix.');`);
  await delay(220);
  await page.evaluate(`document.querySelector('#outside-turn').click()`);
  assert.equal(await page.evaluate(lastRender), 'New unscoped prose with streamed suffix.');
  assert.deepEqual(page.errors, []);
});
