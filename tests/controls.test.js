const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, longChatHtml, waitFor } = require('./helpers/browser');
const { install } = require('./helpers/overlay');
const { install: installContainment } = require('./helpers/containment');
test('playback registers media actions and routes Pause to the active transport', async (t) => {
  const page = await browser(
    t,
    '<title>Media actions</title><main><p>Read this paragraph.</p></main>',
    'https://article.test/media'
  );
  if (!page) return;
  await page.evaluate(
    `window.mediaActions={};Object.defineProperty(navigator,'mediaSession',{value:{playbackState:'none',metadata:null,setActionHandler(name,fn){mediaActions[name]=fn;}}})`
  );
  await install(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
  assert.equal(await page.evaluate('navigator.mediaSession.playbackState'), 'playing');
  assert.equal(await page.evaluate('navigator.mediaSession.metadata.title'), 'Media actions');
  assert.equal(await page.evaluate('typeof mediaActions.pause'), 'function');
  await page.evaluate('mediaActions.pause()');
  await waitFor(page, `panel.querySelector('.status span').textContent==='Paused'`);
  assert.equal(await page.evaluate('navigator.mediaSession.playbackState'), 'paused');
});

test('reloading the same document offers Resume at the matching passage', async (t) => {
  const page = await browser(
    t,
    '<main><p>Opening paragraph.</p><p id="later">The later paragraph where listening stopped.</p><p>Conclusion.</p></main>',
    'https://article.test/resume'
  );
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('#later').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
  const saved = await page.evaluate('saved');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.auditReloaded=true;' });
  await page.send('Page.reload');
  let loaded = false;
  for (let at = 0; at < 200 && !loaded; at++) {
    try {
      loaded = await page.evaluate(`Boolean(window.auditReloaded)&&document.readyState==='complete'`);
    } catch {}
    if (!loaded) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(loaded);
  await install(page, { saved });
  await waitFor(page, `panel.querySelector('.play-label').textContent==='Resume'`);
  assert.equal(await page.evaluate('played.length'), 0, 'reload must not autoplay');
  await page.evaluate(`panel.querySelector('.play').click()`);
  await waitFor(page, `requests.some(r=>r.type==='sonora-render')`);
  assert.equal(
    await page.evaluate(`requests.find(r=>r.type==='sonora-render').text`),
    'The later paragraph where listening stopped.'
  );
});

test('a URL spanning partial discovery cannot stall narration before the conclusion', async (t) => {
  const page = await browser(
    t,
    '<main><p>Read https://example.com/path?tracking=' +
      'x'.repeat(5000) +
      ' then continue.</p><p>Final conclusion.</p></main>',
    'https://article.test/url'
  );
  if (!page) return;
  await page.evaluate(
    `(() => {const timeout=setTimeout;window.setTimeout=(fn,ms,...args)=>ms===50?(window.startIndex=fn,0):timeout(fn,ms,...args);})()`
  );
  await install(page, { auto: true, waitForIndex: false, rejectLongTokens: true });
  await page.evaluate(`document.querySelector('p').click();startIndex()`);
  await waitFor(page, `/complete|Unsafe token/.test(panel.querySelector('.status span').textContent)`);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /complete/);
  const texts = await page.evaluate(`requests.filter(r=>r.type==='sonora-render').map(r=>r.text)`);
  assert(texts.includes('Final conclusion.'));
  assert(texts.every((text) => !text.includes('xxxx')));
  assert.equal(texts.join(' ').split('Link to example.com').length - 1, 1);
});

test('hash navigation cancels playback before the old continuation', async (t) => {
  const page = await browser(
    t,
    '<main><p>OLD first paragraph.</p><p>OLD continuation.</p></main>',
    'https://docs.test/#/old'
  );
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
  await page.evaluate(`location.hash='#/new';document.querySelector('main').innerHTML='<p>NEW document.</p>'`);
  await waitFor(page, `panel.querySelector('.play-label').textContent==='Play from top'`);
  await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
  assert.deepEqual(await page.evaluate('played'), ['OLD first paragraph.']);
});
test('a native media error flushes status and transport behind a pending word frame', async (t) => {
  const page = await browser(
    t,
    '<main><article data-testid="conversation-turn-0"><p>Read this answer.</p></article></main>'
  );
  if (!page) return;
  await installContainment(page, true);
  await page.evaluate('document.querySelector("p").click()');
  await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
  assert.match(await page.evaluate('panel.querySelector(".status span").textContent'), /^Playing/);
  const code = await page.evaluate(`new Promise(resolve => {
    const audio = panel.querySelector('audio');
    audio.addEventListener('error', () => resolve(audio.error.code), {once: true});
    audio.src = 'data:audio/wav;base64,AA=='; audio.load();
  })`);
  assert.equal(code, 4, 'exercise Chromium MediaError rather than a synthetic error event');
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('could not be decoded')`);
  assert.equal(
    await page.evaluate('panel.querySelector(".status span").textContent'),
    'Sonora audio could not be decoded by this browser.'
  );
  assert.equal(await page.evaluate('panel.querySelector(".play-label").textContent'), 'Resume');
  assert.equal(await page.evaluate('panel.querySelector(".play").classList.contains("is-playing")'), false);
  assert.deepEqual(page.errors, []);
});
