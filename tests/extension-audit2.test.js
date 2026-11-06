const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, waitFor } = require('./helpers/browser');
const { install, blocks } = require('./helpers/overlay');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/audit2', name + '.html'), 'utf8');

test('audit2 #1 editors receive clicks and drafts never enter the reading queue', async (t) => {
  const page = await browser(t, fixture('claude'), 'https://claude.ai/chat/audit');
  if (!page) return;
  await install(page, { auto: true });
  const result = await page.evaluate(
    `(() => {const editor=document.querySelector('[contenteditable] p');const allowed=editor.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true,cancelable:true}));return {allowed, renders:requests.filter(r=>r.type==='sonora-render').length};})()`
  );
  assert.deepEqual(result, { allowed: true, renders: 0 });
  await page.evaluate(`document.querySelector('[data-testid="user-message"] p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('complete')`);
  assert(!(await page.evaluate('played')).some((text) => text.includes('draft')));
});

test('audit2 #2 mixed quotes and definitions retain every prose run exactly once', async (t) => {
  const page = await browser(t, fixture('mdn'), 'https://developer.mozilla.org/en-US/docs/audit');
  if (!page) return;
  await install(page);
  const text = (await blocks(page)).join(' ');
  for (const words of [
    'Opening quotation.',
    'Nested quotation paragraph.',
    'Closing quotation.',
    'The argument means',
    'an important explanation.',
    'This tail is required.'
  ]) {
    assert.equal(text.split(words).length - 1, 1, words);
  }
});

test('audit2 #3 nested layout tables keep HN comments independently clickable', async (t) => {
  const page = await browser(t, fixture('hn'), 'https://news.ycombinator.com/item?id=audit');
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelectorAll('.commtext')[1].click()`);
  await waitFor(page, `requests.some(r=>r.type==='sonora-render')`);
  assert.equal(await page.evaluate(`requests.find(r=>r.type==='sonora-render').text`), 'A nested reply.');
});

test('audit2 #3 ordinary reply classes remain prose outside the HN layout', async (t) => {
  const page = await browser(
    t,
    '<main><div class="reply"><p>A substantive reply on another site.</p></div></main>',
    'https://article.test/comments'
  );
  if (!page) return;
  await install(page);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^1 clickable block/);
});

test('audit2 #4 modified links and minimized reading leave page gestures alone', async (t) => {
  const page = await browser(
    t,
    '<main><p>Read <a href="#destination" id="link">this linked paragraph</a>.</p></main>',
    'https://article.test/audit'
  );
  if (!page) return;
  await install(page);
  const result = await page.evaluate(
    `(() => {const link=document.querySelector('#link');const modified=link.dispatchEvent(new MouseEvent('click',{button:0,ctrlKey:true,bubbles:true,cancelable:true}));panel.querySelector('.minimize').click();const hidden=link.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true,cancelable:true}));return {modified,hidden,renders:requests.filter(r=>r.type==='sonora-render').length};})()`
  );
  assert.deepEqual(result, { modified: true, hidden: true, renders: 0 });
});

test('audit2 #6 closed details expose summaries but never their hidden contents', async (t) => {
  const page = await browser(t, fixture('github'), 'https://github.com/example/repo/issues/42');
  if (!page) return;
  await install(page);
  const text = (await blocks(page)).join(' ');
  assert(text.includes('Important reproduction instructions'));
  assert(text.includes('Evidence'));
  assert(!text.includes('Run the app'));
  assert(!text.includes('Secret collapsed'));
});

test('audit2 #6 class-only collapse removes queued hidden prose before playback', async (t) => {
  const page = await browser(
    t,
    '<style>.collapsed{display:none}</style><main><p>Opening paragraph.</p><div id="comment"><p>Hidden comment must not be read.</p></div><p>Conclusion.</p></main>',
    'https://article.test/collapse'
  );
  if (!page) return;
  await install(page, { auto: true });
  await page.evaluate(`document.querySelector('#comment').className='collapsed'`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('complete')`);
  assert(!(await page.evaluate('played')).some((text) => text.includes('Hidden comment')));
});

test('audit2 #7 generic Claude toolbar traffic performs no discovery and edits touch only one message', async (t) => {
  const { claudeHtml } = require('./helpers/claude');
  const page = await browser(t, claudeHtml(), 'https://claude.ai/chat/mutations');
  if (!page) return;
  await install(page);
  await page.evaluate(
    `(() => {window.visits=[];const visible=SonoraPassages.visibleBlock;SonoraPassages.visibleBlock=(node,...args)=>{visits.push(node.textContent);return visible(node,...args);};for(let at=0;at<12;at++)document.querySelector('#ui').textContent='Copy '+at;})()`
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(await page.evaluate('visits'), []);
  await page.evaluate(`document.querySelectorAll('p')[999].firstChild.appendData(' Changed.')`);
  await waitFor(page, 'visits.length > 0');
  assert((await page.evaluate('visits')).every((text) => text.includes('Message 999')));
});

test('audit2 #7 clicking edited unscoped prose refreshes that block before deferred discovery', async (t) => {
  const page = await browser(t, '<main><p>Original prose</p><p>Following paragraph.</p></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    const timeout=setTimeout;
    window.setTimeout=(fn,ms,...args)=>ms===100?(window.deferredRefresh=fn,0):timeout(fn,ms,...args);
    document.querySelector('p').firstChild.appendData(' with streamed suffix.');
  })()`);
  await waitFor(page, `typeof deferredRefresh==='function'`);
  await page.evaluate(`document.querySelector('p').click()`);
  assert.equal(
    await page.evaluate(`requests.find(r=>r.type==='sonora-render')?.text`),
    'Original prose with streamed suffix.'
  );
});

test('audit2 #9 equations have one audible cue instead of disappearing', async (t) => {
  const page = await browser(
    t,
    '<main><p>Energy equals <span class="mwe-math-element"><span style="display:none"><math><mi>E</mi></math></span><img alt="E=mc^2"></span> in this equation.</p><div class="katex"><span aria-hidden="true">F = m a</span></div></main>',
    'https://article.test/math'
  );
  if (!page) return;
  await install(page);
  const text = (await blocks(page)).join(' ');
  assert.equal((text.match(/equation/gi) || []).length, 3);
  assert(!text.includes('F = m a'));
});

test('audit2 #13 hash router documents differ while ordinary heading anchors share identity', () => {
  const { pageIdentity } = require('../extension/passages');
  assert.notEqual(pageIdentity('https://docs.test/#/old'), pageIdentity('https://docs.test/#/new'));
  assert.equal(pageIdentity('https://docs.test/page#one'), pageIdentity('https://docs.test/page#two'));
});

test('audit2 #14 open-shadow replies are discovered once and can be clicked', async (t) => {
  const page = await browser(t, fixture('reddit'), 'https://www.reddit.com/r/example/comments/audit');
  if (!page) return;
  await install(page);
  const text = (await blocks(page)).join(' ');
  assert(text.includes('A substantive visible Reddit reply.'));
  assert(text.includes('Second paragraph of the reply.'));
  await page.evaluate(`document.querySelector('#comment').shadowRoot.querySelector('p').click()`);
  await waitFor(page, `requests.some(r=>r.type==='sonora-render')`);
  assert.equal(
    await page.evaluate(`requests.find(r=>r.type==='sonora-render').text`),
    'A substantive visible Reddit reply.'
  );
});

test('audit2 #15 article content excludes subscription, dialog and recommendation prose', async (t) => {
  const page = await browser(t, fixture('substack'), 'https://example.substack.com/p/audit');
  if (!page) return;
  await install(page, { auto: true });
  await page.evaluate(`panel.querySelector('.play').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('complete')`);
  const text = (await page.evaluate('played')).join(' ');
  assert(text.includes('First essay paragraph.'));
  assert(text.includes('Last visible essay paragraph.'));
  for (const word of ['Subscribe', 'paid subscribers', 'cookies']) assert(!text.includes(word), text);
});

test('audit2 #16 captions and informative alt-only images remain readable without duplicate descriptions', async (t) => {
  const page = await browser(
    t,
    '<main><figure><img alt="A red bridge"><figcaption>Bridge on the north side.</figcaption></figure><p>Directions:</p><img alt="Turn left at the red bridge."></main>',
    'https://article.test/captions'
  );
  if (!page) return;
  await install(page);
  const text = (await blocks(page)).join(' ');
  assert(text.includes('Bridge on the north side.'));
  assert(text.includes('Turn left at the red bridge.'));
  assert(!text.includes('A red bridge'));
});

test('audit2 #17 citation nodes disappear while ordinary bracketed prose remains', async (t) => {
  const page = await browser(
    t,
    '<main><p>Water boils.<sup class="reference"><a>[12]</a></sup> Read [this explanation] and [12 useful examples].</p></main>',
    'https://en.wikipedia.org/wiki/Audit'
  );
  if (!page) return;
  await install(page);
  assert.deepEqual(await blocks(page), ['Water boils. Read [this explanation] and [12 useful examples].']);
});

test('audit2 #24 a one-letter answer or vocabulary entry is a readable semantic block', async (t) => {
  const page = await browser(
    t,
    '<meta charset="utf-8"><main><p>I</p><p lang="ja">猫</p></main>',
    'https://article.test/short'
  );
  if (!page) return;
  await install(page);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^2 clickable blocks/);
});

test('audit2 #20 playback registers media actions and routes Pause to the active transport', async (t) => {
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

test('audit2 #22 reloading the same document offers Resume at the matching passage', async (t) => {
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

test('audit2 #23 PDF viewers explain the import route and provide a reader action', async (t) => {
  const page = await browser(t, '<main></main>', 'https://article.test/audit.pdf');
  if (!page) return;
  await page.evaluate(`window.__sonoraPdfUrl='https://article.test/audit.pdf'`);
  await install(page);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /PDF.*reader/i);
  assert.equal(await page.evaluate(`panel.querySelector('.pdf-reader')?.textContent`), 'Open PDF in reader');
  await page.evaluate(`panel.querySelector('.pdf-reader').click()`);
  assert(await page.evaluate(`requests.some(r=>r.type==='sonora-open-pdf-reader')`));
});

test('audit2 #12 a URL spanning partial discovery cannot stall narration before the conclusion', async (t) => {
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

test('audit2 #13 hash navigation cancels playback before the old continuation', async (t) => {
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

test('audit2 #14 shadow slots continue in composed order and refresh edited replies', async (t) => {
  const page = await browser(
    t,
    '<main><article-box><p slot="reply">Slotted reply.</p></article-box><p>After the component.</p></main>',
    'https://article.test/shadow'
  );
  if (!page) return;
  await page.evaluate(
    `document.querySelector('article-box').attachShadow({mode:'open'}).innerHTML='<p>Shadow opening.</p><slot name="reply"></slot><p id="tail">Shadow tail.</p>'`
  );
  await install(page, { auto: true });
  await page.evaluate(
    `document.querySelector('article-box').shadowRoot.querySelector('#tail').firstChild.data='Edited shadow tail.'`
  );
  await waitFor(page, `panel.querySelector('.meta').textContent.includes('74 characters')`);
  await page.evaluate(`document.querySelector('article-box').shadowRoot.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('complete')`);
  assert.deepEqual(await page.evaluate('played'), [
    'Shadow opening.',
    'Slotted reply.',
    'Edited shadow tail.',
    'After the component.'
  ]);
});

test('audit2 #22 changed text invalidates an offered Resume', async (t) => {
  const document = 'https://article.test/stale-resume';
  const saved = {
    sonoraPositions: [
      { document, prefix: 'Old later paragraph.', text: 'Old later paragraph.', offset: 0, blockIndex: 1 }
    ]
  };
  const page = await browser(
    t,
    '<main><p>Opening paragraph.</p><p id="later">Old later paragraph.</p></main>',
    document
  );
  if (!page) return;
  await install(page, { saved });
  await waitFor(page, `panel.querySelector('.play-label').textContent==='Resume'`);
  await page.evaluate(`document.querySelector('#later').firstChild.data='Changed later paragraph.'`);
  await waitFor(page, `panel.querySelector('.meta').textContent.includes('44 characters')`);
  assert.equal(await page.evaluate(`panel.querySelector('.play-label').textContent`), 'Play from top');
  await page.evaluate(`panel.querySelector('.play').click()`);
  await waitFor(page, `requests.some(r=>r.type==='sonora-render')`);
  assert(
    !(await page.evaluate(`requests.filter(r=>r.type==='sonora-render').map(r=>r.text)`)).includes(
      'Old later paragraph.'
    )
  );
});
