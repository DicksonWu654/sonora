const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, waitFor } = require('./helpers/browser');
const { install, blocks } = require('./helpers/overlay');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/articles', name + '.html'), 'utf8');
test('editors receive clicks and drafts never enter the reading queue', async (t) => {
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

test('mixed quotes and definitions retain every prose run exactly once', async (t) => {
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

test('nested layout tables keep HN comments independently clickable', async (t) => {
  const page = await browser(t, fixture('hn'), 'https://news.ycombinator.com/item?id=audit');
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelectorAll('.commtext')[1].click()`);
  await waitFor(page, `requests.some(r=>r.type==='sonora-render')`);
  assert.equal(await page.evaluate(`requests.find(r=>r.type==='sonora-render').text`), 'A nested reply.');
});

test('modified links and minimized reading leave page gestures alone', async (t) => {
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

test('closed details expose summaries but never their hidden contents', async (t) => {
  const page = await browser(t, fixture('github'), 'https://github.com/example/repo/issues/42');
  if (!page) return;
  await install(page);
  const text = (await blocks(page)).join(' ');
  assert(text.includes('Important reproduction instructions'));
  assert(text.includes('Evidence'));
  assert(!text.includes('Run the app'));
  assert(!text.includes('Secret collapsed'));
});

test('class-only collapse removes queued hidden prose before playback', async (t) => {
  const page = await browser(
    t,
    '<style>.collapsed{display:none}</style><main><p>Opening paragraph.</p><div id="comment"><p>Hidden comment must not be read.</p></div><p>Conclusion.</p></main>',
    'https://article.test/collapse'
  );
  if (!page) return;
  await install(page, { auto: true });
  await page.evaluate(`document.querySelector('#comment').className='collapsed'`);
  await waitFor(page, `/^2 clickable blocks/.test(panel.querySelector('.meta').textContent)`);
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('complete')`);
  assert(!(await page.evaluate('played')).some((text) => text.includes('Hidden comment')));
});

test('equations have one audible cue instead of disappearing', async (t) => {
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

test('article content excludes subscription, dialog and recommendation prose', async (t) => {
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

test('captions and informative alt-only images remain readable without duplicate descriptions', async (t) => {
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

test('citation nodes disappear while ordinary bracketed prose remains', async (t) => {
  const page = await browser(
    t,
    '<main><p>Water boils.<sup class="reference"><a>[12]</a></sup> Read [this explanation] and [12 useful examples].</p></main>',
    'https://en.wikipedia.org/wiki/Audit'
  );
  if (!page) return;
  await install(page);
  assert.deepEqual(await blocks(page), ['Water boils. Read [this explanation] and [12 useful examples].']);
});

test('a one-letter answer or vocabulary entry is a readable semantic block', async (t) => {
  const page = await browser(
    t,
    '<meta charset="utf-8"><main><p>I</p><p lang="ja">猫</p></main>',
    'https://article.test/short'
  );
  if (!page) return;
  await install(page);
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^2 clickable blocks/);
});

test('shadow slots continue in composed order and refresh edited replies', async (t) => {
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
test('nested generic wrappers produce clickable passages and hide transparent descendants', async (t) => {
  const page = await browser(
    t,
    '<main><div><div><span>Visible article text</span></div></div><div>Mixed <span>inline wrapper</span></div><p>Visible <span style="opacity:0">Copy code</span> prose</p></main>',
    'https://example.test/article'
  );
  if (!page) return;
  await install(page);
  const texts = await page.evaluate(
    `[...document.querySelectorAll('.sonora-readable-block')].map(node => SonoraPassages.readableText(node, BookText.cleanText))`
  );
  assert.deepEqual(texts, ['Visible article text', 'Mixed inline wrapper', 'Visible prose']);
  assert.deepEqual(page.errors, []);
});

test('generic wrappers inside a list entry are read once while nested entries remain separate', async (t) => {
  const page = await browser(
    t,
    '<main><ul><li><div>Parent entry.</div><ul><li><span>Child entry.</span></li></ul></li></ul></main>'
  );
  if (!page) return;
  await install(page);
  const texts = await page.evaluate(
    `[...document.querySelectorAll('.sonora-readable-block')].map(node => SonoraPassages.readableText(node, BookText.cleanText))`
  );
  assert.deepEqual(texts, ['Parent entry.', 'Child entry.']);
  assert.deepEqual(page.errors, []);
});
test('playback sends an unsupported-language cue and continues through surrounding prose', async (t) => {
  const { browser, waitFor } = require('./helpers/browser');
  const { install } = require('./helpers/overlay');
  const page = await browser(
    t,
    '<meta charset="utf-8"><main><p>English opening.</p><p>هذا نص عربي</p><p>Final conclusion.</p></main>',
    'https://article.test/languages'
  );
  if (!page) return;
  await install(page, { auto: true });
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('complete')`);
  assert.deepEqual(await page.evaluate('played'), ['English opening.', 'Unsupported language.', 'Final conclusion.']);
});
