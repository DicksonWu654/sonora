const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { browser, waitFor } = require('./helpers/browser');
const { connect, target } = require('./helpers/unpacked');

const article = '<!doctype html><meta charset="utf-8"><style>body{font:18px/1.5 sans-serif}pre{white-space:pre}</style><main><h1>Embedded article</h1><p id="read">Read this embedded article aloud with local speech.</p><h2>Details</h2><ul><li>A list item.</li></ul><table><tr><td>A table cell.</td></tr></table><pre><code>alpha();\nbeta();</code></pre><dl><dt>A term</dt><dd>Its definition.</dd></dl><textarea>Editable source text.</textarea></main>';

async function fixture(t) {
  const renders = [];
  const wav = Buffer.alloc(44 + 48000 * 8);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const content = http.createServer((req, res) => {res.setHeader('content-type', 'text/html'); res.end(article);});
  await new Promise(resolve => content.listen(0, '127.0.0.2', resolve));
  const frameUrl = `http://127.0.0.2:${content.address().port}/document`;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/narration/render') {
      let raw = ''; for await (const data of req) raw += data;
      const body = JSON.parse(raw); renders.push(body);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({audioUrl: '/api/narration/audio/' + 'a'.repeat(64) + '.wav', duration: 8,
        words: [{start: 0, end: 8, textOffset: 0, length: body.text.split(/\s+/)[0].length}]}));
    }
    if (req.url.startsWith('/api/narration/audio/')) {res.setHeader('content-type', 'audio/wav'); return res.end(wav);}
    if (req.url === '/api/narration/status') {res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ready: true}));}
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><nav><button>Share</button></nav><iframe sandbox="allow-scripts allow-same-origin" src="${frameUrl}"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {for (const item of [content, server]) {item.closeAllConnections(); await new Promise(resolve => item.close(resolve));}});
  const extension = path.join(__dirname, '../extension'), url = `http://127.0.0.1:${server.address().port}`;
  const page = await browser(t, null, url, {network: true, args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
  if (!page) return null;
  const version = await (await fetch(`http://127.0.0.1:${page.port}/json/version`)).json();
  const browserCdp = await connect(t, version.webSocketDebuggerUrl, false);
  const extensionId = crypto.createHash('sha256').update(extension).digest('hex').slice(0, 32).replace(/./g, char => String.fromCharCode(97 + parseInt(char, 16)));
  const worker = await target(t, page.port, item => item.type === 'service_worker' && item.url === 'chrome-extension://' + extensionId + '/background.js');
  await waitFor(worker, `Boolean(globalThis.chrome?.storage?.local)`);
  await worker.evaluate(`chrome.storage.local.set({sonoraServer: ${JSON.stringify(url)}})`);
  const id = new URL(worker.target.url).hostname;
  async function clickToolbar() {
    const tab = (await browserCdp.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}]})).targetInfos.find(item => item.url === url + '/');
    await browserCdp.send('Extensions.triggerAction', {id, targetId: tab.targetId});
  }
  const frameExpression = expression => `chrome.tabs.query({url: ${JSON.stringify(url + '/*')}}).then(async tabs => {
    const results = await chrome.scripting.executeScript({target: {tabId: tabs[0].id, allFrames: true}, func: () => {
      if (location.hostname !== '127.0.0.2') return null;
      const host = document.querySelector('#sonora-overlay-root');
      const panel = host && chrome.dom.openOrClosedShadowRoot(host);
      return (${expression});
    }});
    return results.find(item => item.result !== null)?.result;
  })`;
  const inFrame = expression => worker.evaluate(frameExpression(expression));
  const waitInFrame = expression => waitFor(worker, frameExpression(expression));
  return {page, worker, renders, clickToolbar, inFrame, waitInFrame, id, browserCdp};
}

test('unpacked MV3 iframe reader requests one origin, renders a real frame click, highlights and keeps the speed setting', async t => {
  const f = await fixture(t); if (!f) return;
  const {page, worker, clickToolbar, inFrame, waitInFrame, renders} = f;
  assert.equal(await worker.evaluate(`chrome.permissions.contains({origins: ['http://127.0.0.2/*']})`), false);
  await clickToolbar();
  const prompt = await target(t, page.port, item => item.url.includes('/frame-permission.html?'));
  await waitFor(prompt, `document.readyState === 'complete'`);
  assert.equal(new URL(prompt.target.url).searchParams.get('origin'), 'http://127.0.0.2/*');
  // Headless Chrome cannot answer its native optional-permission dialog. Grant
  // the single host through Chrome's own extension settings (not an API mock),
  // then exercise the real permissions.request click and saved grant handoff.
  const settingsTarget = await f.browserCdp.send('Target.createTarget', {url: 'chrome://extensions/'});
  const settings = await target(t, page.port, item => item.id === settingsTarget.targetId);
  await waitFor(settings, `Boolean(chrome.developerPrivate)`);
  await settings.evaluate(`chrome.developerPrivate.addHostPermission(${JSON.stringify(f.id)}, 'http://127.0.0.2/*')`);
  await f.browserCdp.send('Target.closeTarget', {targetId: settingsTarget.targetId});
  await f.browserCdp.send('Target.activateTarget', {targetId: prompt.target.id});
  const button = await prompt.evaluate(`(() => {document.querySelector('#allow').scrollIntoView(); const r = document.querySelector('#allow').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await prompt.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...button});
  await prompt.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...button});
  await waitFor(worker, `chrome.permissions.contains({origins: ['http://127.0.0.2/*']})`);
  await waitInFrame(`Boolean(panel && window.__sonoraOverlay)`);
  await inFrame(`window.__sonoraOverlay.whenIndexed.then(() => true)`);
  assert.equal(await page.evaluate(`Boolean(document.querySelector('#sonora-overlay-root'))`), false);
  const point = await inFrame(`(() => {const r=document.querySelector('#read').getBoundingClientRect(); return {x:r.x+10,y:r.y+10};})()`);
  const framePoint = await page.evaluate(`(() => {const r=document.querySelector('iframe').getBoundingClientRect(); return {x:r.x,y:r.y};})()`);
  const clicked = {x: framePoint.x + point.x, y: framePoint.y + point.y};
  await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...clicked});
  await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...clicked});
  const text = await inFrame(`(() => {
    const slider = panel.querySelector('input[type="range"]'); slider.value='1.7'; slider.dispatchEvent(new Event('input',{bubbles:true}));
    return document.querySelector('#read').textContent;
  })()`);
  const deadline = Date.now() + 10000;
  while (!renders.some(item => item.text === text) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(renders.some(item => item.text === text));
  await waitInFrame(`Boolean(CSS.highlights.get('sonora-current-word')?.size || panel.querySelector('.word-mark'))`);
  assert.equal(await worker.evaluate(`chrome.storage.local.get('sonoraSpeed').then(value => value.sonoraSpeed)`), 1.7);
  await clickToolbar();
  await waitInFrame(`panel.querySelector('.panel').classList.contains('is-hidden')`);
  assert.equal(await inFrame(`panel.querySelector('.panel').classList.contains('is-hidden')`), true);
  await clickToolbar();
  await waitInFrame(`!panel.querySelector('.panel').classList.contains('is-hidden')`);
  assert.equal(await inFrame(`panel.querySelector('.panel').classList.contains('is-hidden')`), false);
  assert.deepEqual(page.errors, []); assert.deepEqual(worker.errors, []);
});

test('unpacked MV3 permission denial leaves an explanatory panel in the parent frame', async t => {
  const f = await fixture(t); if (!f) return;
  const {page, worker, clickToolbar} = f;
  await clickToolbar();
  const prompt = await target(t, page.port, item => item.url.includes('/frame-permission.html?'));
  await waitFor(prompt, `document.readyState === 'complete'`);
  await prompt.evaluate(`document.querySelector('#deny').click()`);
  await waitFor(worker, `chrome.tabs.query({url: 'http://127.0.0.1/*'}).then(async tabs => {
    const results = await chrome.scripting.executeScript({target:{tabId:tabs[0].id},func:()=>chrome.dom.openOrClosedShadowRoot(document.querySelector('#sonora-overlay-root'))?.querySelector('.meta').textContent});
    return /permission.*denied/i.test(results[0].result);
  })`);
  assert.equal(await worker.evaluate(`chrome.permissions.contains({origins: ['http://127.0.0.2/*']})`), false);
  assert.deepEqual(page.errors, []); assert.deepEqual(worker.errors, []);
});
