const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ready } = require('./helpers/frame-extension');
const { target } = require('./helpers/unpacked');
const start = '<!doctype html><style>body{margin:0}iframe{border:0;position:absolute;top:0}</style>';
const prose = 'The surrounding conversation remains the default document. '.repeat(5);
async function frame(f, index) {
  const loaded = await f.loaded();
  return loaded.find((item) => item.url.startsWith(f.urls[index] + '/')).frameId;
}
test('unpacked top and embedded switches retire the other panel and native audio', async (t) => {
  const f = await fixture(
    t,
    (urls) =>
      start +
      '<main style="width:400px"><p>' +
      prose +
      '</p></main><iframe style="left:420px;width:900px;height:700px" src="' +
      urls[1] +
      '/article"></iframe>'
  );
  if (!f) return;
  await f.grant('http://127.0.0.2/*');
  await f.toolbar();
  await f.waitInFrame(0, 'Boolean(panel)');
  assert.equal(await f.inFrame(0, `panel.querySelector('.frame-switch').hidden`), false);
  assert.deepEqual(await f.readers(), [0]);
  await f.play(0);
  await f.inFrame(0, `panel.querySelector('.frame-switch').click()`);
  const embedded = await frame(f, 1);
  await f.waitInFrame(embedded, 'Boolean(panel)');
  assert.deepEqual(await f.readers(), [embedded]);
  assert.equal(await f.inFrame(0, 'nativeSources.every(source=>!source.started||source.stopped||source.ended)'), true);
  assert.equal(await f.inFrame(embedded, `panel.querySelector('.frame-switch').textContent`), 'Read top page');
  await f.play(embedded);
  await f.inFrame(embedded, `panel.querySelector('.frame-switch').click()`);
  await f.waitInFrame(0, 'Boolean(panel)');
  assert.deepEqual(await f.readers(), [0]);
  assert.equal(
    await f.inFrame(embedded, 'nativeSources.every(source=>!source.started||source.stopped||source.ended)'),
    true
  );
  assert.deepEqual(f.page.errors, []);
  assert.deepEqual(f.worker.errors, []);
});

test('unpacked sibling resizing switches readers without leaving the first audio source alive', async (t) => {
  const f = await fixture(
    t,
    (urls) =>
      start +
      `<iframe id="first" style="left:0;width:700px;height:650px" src="${urls[1]}/one"></iframe><iframe style="left:720px;width:560px;height:600px" src="${urls[2]}/two"></iframe>`
  );
  if (!f) return;
  await f.grant('http://127.0.0.2/*');
  await f.grant('http://127.0.0.3/*');
  await f.toolbar();
  const first = await frame(f, 1),
    second = await frame(f, 2);
  await f.waitInFrame(first, 'Boolean(panel)');
  await f.play(first);
  await f.page.evaluate(`document.querySelector('#first').style.width='400px'`);
  await f.toolbar();
  await f.waitInFrame(second, 'Boolean(panel)');
  assert.deepEqual(await f.readers(), [second]);
  assert.equal(
    await f.inFrame(first, 'nativeSources.every(source=>!source.started||source.stopped||source.ended)'),
    true
  );
  await f.play(second);
  assert.deepEqual(f.worker.errors, []);
});

test('unpacked redirect requests the loaded origin and can read it after granting access', async (t) => {
  const f = await fixture(
    t,
    (urls) => start + `<iframe style="left:0;width:1000px;height:700px" src="${urls[1]}/redirect"></iframe>`
  );
  if (!f) return;
  assert.equal(await f.page.evaluate(`document.querySelector('iframe').src`), f.urls[1] + '/redirect');
  await f.toolbar();
  const prompt = await target(t, f.page.port, (item) => item.url.includes('/frame-permission.html?'));
  await ready(prompt, `document.readyState==='complete'&&Boolean(document.querySelector('#allow'))`);
  assert.equal(new URL(prompt.target.url).searchParams.get('origin'), 'http://127.0.0.3/*');
  await f.grant('http://127.0.0.3/*');
  await f.cdp.send('Target.activateTarget', { targetId: prompt.target.id });
  const point = await prompt.evaluate(
    `(() => {const r=document.querySelector('#allow').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  );
  await prompt.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point
  });
  await prompt.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point
  });
  const document = await frame(f, 2);
  await f.waitInFrame(document, 'Boolean(panel)');
  await f.play(document);
  assert(f.renders.some((r) => r.text === 'Readable embedded document 2.'));
  assert.equal(await f.worker.evaluate(`chrome.permissions.contains({origins:['http://127.0.0.2/*']})`), false);
  assert.deepEqual(f.worker.errors, []);
});

test('denying embedded-document access explains the missing text in the parent panel', async (t) => {
  const f = await fixture(
    t,
    (urls) => start + `<iframe style="width:1000px;height:700px" src="${urls[1]}/article"></iframe>`
  );
  if (!f) return;
  await f.toolbar();
  const prompt = await target(t, f.page.port, (item) => item.url.includes('/frame-permission.html?'));
  await ready(prompt, `document.readyState==='complete'&&Boolean(document.querySelector('#deny'))`);
  await prompt.evaluate(`document.querySelector('#deny').click()`);
  await f.waitInFrame(0, `/permission.*denied/i.test(panel?.querySelector('.meta').textContent)`);
  assert.equal(await f.worker.evaluate(`chrome.permissions.contains({origins:['http://127.0.0.2/*']})`), false);
  assert.equal(f.renders.length, 0);
  assert.deepEqual(f.page.errors, []);
  assert.deepEqual(f.worker.errors, []);
});

test('unpacked selection ignores a fully clipped readable frame', async (t) => {
  const f = await fixture(
    t,
    (urls) =>
      start +
      `<div style="height:0;overflow:hidden;position:relative"><iframe style="position:relative;width:1200px;height:800px" src="${urls[1]}/clipped"></iframe></div><iframe style="left:0;width:900px;height:650px" src="${urls[2]}/visible"></iframe>`
  );
  if (!f) return;
  await f.grant('http://127.0.0.2/*');
  await f.grant('http://127.0.0.3/*');
  await f.toolbar();
  const visible = await frame(f, 2);
  await f.waitInFrame(visible, 'Boolean(panel)');
  assert.deepEqual(await f.readers(), [visible]);
  assert.deepEqual(f.worker.errors, []);
});

test('unpacked readable document wins over a larger ungranted advertisement', async (t) => {
  const f = await fixture(
    t,
    (urls) =>
      start +
      `<iframe style="left:0;width:700px;height:650px" src="${urls[1]}/ad"></iframe><iframe style="left:720px;width:560px;height:600px" src="${urls[2]}/article"></iframe>`
  );
  if (!f) return;
  await f.grant('http://127.0.0.3/*');
  await f.toolbar();
  const article = await frame(f, 2);
  await f.waitInFrame(article, 'Boolean(panel)');
  assert.deepEqual(await f.readers(), [article]);
  const tabs = await f.worker.evaluate('chrome.tabs.query({})');
  assert(!tabs.some((tab) => tab.url?.includes('/frame-permission.html')));
  assert.deepEqual(f.worker.errors, []);
});

test('unpacked short notices and articles beyond the probe budget keep their own reader', async (t) => {
  for (const content of [
    '<p>The library closes early today. Please return tomorrow morning.</p>',
    '<div><span></span></div>'.repeat(300) + '<p>' + prose.repeat(500) + '</p>'
  ])
    await t.test(content.length > 1000 ? 'budget exhausted' : 'short notice', async (t) => {
      const f = await fixture(
        t,
        (urls) =>
          start +
          '<main>' +
          content +
          `</main><iframe style="left:1000px;width:300px;height:250px" src="${urls[1]}/ad"></iframe>`
      );
      if (!f) return;
      await f.grant('http://127.0.0.2/*');
      await f.toolbar();
      await f.waitInFrame(0, 'Boolean(panel)');
      assert.deepEqual(await f.readers(), [0]);
      assert.equal(await f.inFrame(0, `panel.querySelector('.frame-switch').hidden`), true);
      await f.play(0);
      assert(f.renders.some((r) => r.text.startsWith(content.length > 1000 ? 'The surrounding' : 'The library')));
      assert.deepEqual(f.worker.errors, []);
    });
});

test('unpacked access page discloses the Claude service pattern and one grant covers two artifacts', async (t) => {
  const f = await fixture(t, () => start + '<main><p>Parent document.</p></main>');
  if (!f) return;
  const pattern = 'https://*.frame.claudeusercontent.com/*';
  const permission =
    `chrome-extension://${f.id}/frame-permission.html?` +
    new URLSearchParams({
      tab: String(f.tabId),
      url: f.urls[0] + '/page',
      origin: pattern
    });
  const opened = await f.cdp.send('Target.createTarget', { url: permission });
  const prompt = await target(t, f.page.port, (item) => item.id === opened.targetId);
  await ready(prompt, `document.readyState==='complete'&&Boolean(document.querySelector('#allow'))`);
  assert.match(await prompt.evaluate('document.body.textContent'), /all Claude artifacts/);
  assert.match(
    await prompt.evaluate(`document.querySelector('#scope').textContent`),
    /https:\/\/\*\.frame\.claudeusercontent\.com\/\*/
  );
  // Native optional-permission dialogs are unavailable in headless Chromium.
  // Seed Chrome's actual permission store, then exercise permissions.request
  // through a trusted click as with the existing exact-origin integration test.
  await f.grant(pattern);
  await f.cdp.send('Target.activateTarget', { targetId: prompt.target.id });
  const point = await prompt.evaluate(
    `(() => {const r=document.querySelector('#allow').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  );
  await prompt.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point
  });
  await prompt.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point
  });
  await f.waitInFrame(0, 'Boolean(panel)');
  assert.equal(
    await f.worker.evaluate(
      `chrome.permissions.contains({origins:['https://one.frame.claudeusercontent.com/*','https://two.frame.claudeusercontent.com/*']})`
    ),
    true
  );
  assert.equal(await f.worker.evaluate(`chrome.permissions.contains({origins:['https://unrelated.test/*']})`), false);
  assert.deepEqual(f.worker.errors, []);
});
const { fixture: nativeFixture, readyDocument, until } = require('./helpers/native-reader');
test('Back restores a paused reader that reclaims playback ownership before resuming', async (t) => {
  const f = await nativeFixture(t);
  if (!f) return;
  await f.open('/a');
  await f.inTab(
    '/a',
    `(() => {window.historyRestored=false; addEventListener('pageshow', event => {window.historyRestored=event.persisted;}); document.querySelector('p').click();})()`
  );
  await f.waitInTab('/a', `nativeSources.some(source => source.started && !source.stopped && !source.ended)`);
  await f.page.send('Page.navigate', { url: f.base + '/away' });
  await readyDocument(f.page, `location.pathname==='/away' && document.readyState==='complete'`);
  const next = await f.cdp.send('Target.createTarget', { url: f.base + '/b' });
  const second = await target(t, f.page.port, (item) => item.id === next.targetId);
  await readyDocument(second, `document.readyState==='complete' && Boolean(document.querySelector('p'))`);
  await f.open('/b');
  await f.inTab('/b', `document.querySelector('p').click()`);
  await f.waitInTab('/b', `nativeSources.some(source => source.started && !source.stopped && !source.ended)`);
  const history = await f.page.send('Page.getNavigationHistory');
  const original = history.entries.find((entry) => entry.url === f.base + '/a');
  await f.page.send('Page.navigateToHistoryEntry', { entryId: original.id });
  await readyDocument(f.page, `location.pathname==='/a' && document.readyState==='complete'`);
  assert.equal(await f.inTab('/a', 'window.historyRestored'), true, 'use Chromium back/forward cache, not reinjection');
  await f.inTab('/a', `panel.querySelector('.play').click()`);
  await f.waitInTab('/a', `nativeSources.some(source => source.started && !source.stopped && !source.ended)`);
  assert.equal(
    await f.inTab('/b', `nativeSources.every(source => !source.started || source.stopped || source.ended)`),
    true
  );
  const owner = await f.worker.evaluate(
    `chrome.storage.session.get('sonoraPlaybackOwner').then(saved => saved.sonoraPlaybackOwner)`
  );
  const tab = await f.worker.evaluate(
    `chrome.tabs.query({url:${JSON.stringify(f.base + '/a')}}).then(tabs => tabs[0].id)`
  );
  assert.equal(owner.tab.id, tab);
  assert.deepEqual(f.page.errors, []);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(f.worker.errors, []);
});

test('unpacked tab close aborts the pending HTTP render connection', async (t) => {
  const f = await nativeFixture(t);
  if (!f) return;
  const opened = await f.cdp.send('Target.createTarget', {
    url: f.base + '/slow'
  });
  const slow = await target(t, f.page.port, (item) => item.id === opened.targetId);
  await readyDocument(slow, `document.readyState === 'complete' && Boolean(document.querySelector('p'))`);
  await f.open('/slow');
  await f.inTab('/slow', `document.querySelector('p').click()`);
  await until(() => f.slow.length > 0);
  assert.equal(f.slow[0].closed, false);
  await f.cdp.send('Target.closeTarget', { targetId: opened.targetId });
  await until(() => f.slow[0].closed);
  assert.deepEqual(f.worker.errors, []);
});

test('single-page history updates, as ChatGPT makes while reading, do not cancel a pending render', async (t) => {
  const f = await nativeFixture(t);
  if (!f) return;
  const opened = await f.cdp.send('Target.createTarget', { url: f.base + '/slow' });
  const slow = await target(t, f.page.port, (item) => item.id === opened.targetId);
  await readyDocument(slow, `document.readyState === 'complete' && Boolean(document.querySelector('p'))`);
  await f.open('/slow');
  await f.inTab('/slow', `document.querySelector('p').click()`);
  await until(() => f.slow.length > 0);
  await slow.evaluate(`history.replaceState({}, '', '/slow?model=other'); history.pushState({}, '', '/slow?model=third')`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(f.slow[0].closed, false, 'tabs.onUpdated reports loading for history.replaceState; the render must survive');
  assert.doesNotMatch(await f.inTab('/slow?model=third', `panel.querySelector('.status span').textContent`), /cancelled/);
  await f.cdp.send('Target.closeTarget', { targetId: opened.targetId });
  await until(() => f.slow[0].closed);
  assert.deepEqual(f.worker.errors, []);
});

test('unpacked extension stops native audio in the previous tab before starting the next', async (t) => {
  const f = await nativeFixture(t);
  if (!f) return;
  await f.open('/a');
  await f.inTab('/a', `document.querySelector('p').click()`);
  await f.waitInTab(
    '/a',
    `nativeSources.some(source => source.started && !source.ended) && panel.querySelector('.status span').textContent.startsWith('Playing')`
  );
  const next = await f.cdp.send('Target.createTarget', { url: f.base + '/b' });
  const second = await target(t, f.page.port, (item) => item.id === next.targetId);
  await readyDocument(second, `document.readyState === 'complete' && Boolean(document.querySelector('p'))`);
  await f.open('/b');
  await f.inTab('/b', `document.querySelector('p').click()`);
  await f.waitInTab(
    '/b',
    `nativeSources.some(source => source.started && !source.ended) && panel.querySelector('.status span').textContent.startsWith('Playing')`
  );
  assert.equal(
    await f.inTab('/a', 'nativeSources.every(source => !source.started || source.stopped || source.ended)'),
    true
  );
  const first = (await f.cdp.send('Target.getTargets')).targetInfos.find(
    (item) => item.url === f.base + '/a' && item.type === 'page'
  );
  await f.cdp.send('Target.activateTarget', { targetId: first.targetId });
  await f.waitInTab('/a', `/Paused.*another tab/.test(panel.querySelector('.status span').textContent)`);
  assert.equal(await f.inTab('/a', 'navigator.mediaSession.playbackState'), 'none');
  assert.equal(await f.inTab('/b', 'navigator.mediaSession.playbackState'), 'playing');
  assert(f.requests.some((request) => request.text.includes('/a')));
  assert(f.requests.some((request) => request.text.includes('/b')));
  assert.deepEqual(f.page.errors, []);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(f.worker.errors, []);
});

test('Chromium PDF viewer offers a working handoff to the existing import reader', async (t) => {
  const f = await nativeFixture(t);
  if (!f) return;
  const opened = await f.cdp.send('Target.createTarget', {
    url: f.base + '/document.pdf'
  });
  const viewer = await target(t, f.page.port, (item) => item.id === opened.targetId);
  await readyDocument(
    viewer,
    `document.readyState==='complete' && (document.contentType==='application/pdf' || Boolean(document.querySelector('embed[type="application/pdf"]')))`
  );
  await f.open('/document.pdf');
  assert.match(await f.inTab('/document.pdf', `panel.querySelector('.meta').textContent`), /PDF.*reader/i);
  assert.match(
    await f.inTab('/document.pdf', `panel.querySelector('.selection-copy').textContent`),
    /save.*import file/i
  );
  await f.inTab('/document.pdf', `panel.querySelector('.pdf-reader').click()`);
  const reader = await target(t, f.page.port, (item) => item.type === 'page' && item.url === f.base + '/');
  assert.equal(reader.target.url, f.base + '/');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(viewer.errors, []);
  assert.deepEqual(f.worker.errors, []);
});
