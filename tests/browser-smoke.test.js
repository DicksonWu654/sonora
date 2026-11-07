const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/frame-extension');
const { longChatHtml, browser, extensionArgs, waitFor } = require('./helpers/browser');
const { install } = require('./helpers/overlay');

describe('browser smoke', () => {
  let f;
  let article = '<main><p>Read this normal article aloud.</p></main>';
  const cleanup = [];
  after(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });
  before(async () => {
    f = await fixture(
      {
        after: (fn) => cleanup.push(fn),
        skip: (reason) => {
          throw new Error(reason);
        }
      },
      (urls, req) => (req.url === '/embedded' ? '<main><p>Read this embedded artifact.</p></main>' : article)
    );
  });

  test('overlay opens from the real toolbar action', async () => {
    await f.toolbar();
    await f.waitInFrame(0, 'Boolean(panel && panel.querySelector(".controls"))');
    assert.equal(await f.inFrame(0, `panel.querySelector('.panel').classList.contains('is-hidden')`), false);
    await f.toolbar();
    await f.toolbar();
    assert.deepEqual(await f.readers(), [0]);
  });

  test('clicking normal prose sends a render and starts native playback', async () => {
    await f.play(0);
    assert.equal(f.renders.filter((item) => item.text === 'Read this normal article aloud.').length, 1);
    await f.inFrame(0, `panel.querySelector('.close').click()`);
  });

  test('a long ChatGPT conversation remains clickable while its last turn streams', async (t) => {
    const page = await browser(t, longChatHtml(500), 'https://chatgpt.com/c/smoke', { args: extensionArgs() });
    await install(page, { waitForIndex: false });
    await page.evaluate(`document.querySelector('[data-testid="conversation-turn-499"] p').append(' Streamed tail.')`);
    await page.evaluate(`document.querySelector('[data-testid="conversation-turn-499"] p').click()`);
    await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
    assert.match(
      await page.evaluate(`requests.find(item=>item.type==='sonora-render').text`),
      /^Turn 499 says answer\(\) aloud/
    );
    assert.deepEqual(page.errors, []);
  });

  test('Docs canvas paragraph annotations can start reading', async (t) => {
    const html =
      '<div class="kix-appview-editor"><div class="kix-rotatingtilemanager" style="width:800px;height:400px"><svg width="800" height="400"><g role="paragraph"><rect aria-label="Read this Docs paragraph." data-font-css="16px sans-serif" x="20" y="30" width="300" height="24"></rect></g></svg></div></div>';
    const page = await browser(t, html, 'https://docs.google.com/document/d/smoke/edit', { args: extensionArgs() });
    await install(page);
    await page.evaluate(
      `(() => {const node=document.querySelector('rect'),r=node.getBoundingClientRect();node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:r.x+10,clientY:r.y+10}));})()`
    );
    await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
    assert.equal(
      await page.evaluate(`requests.find(item=>item.type==='sonora-render').text`),
      'Read this Docs paragraph.'
    );
    assert.deepEqual(page.errors, []);
  });

  test('an embedded article renders, highlights and accepts slider changes', async () => {
    const embeddedUrl = f.urls[0].replace('127.0.0.1', 'localhost') + '/embedded';
    article = `<iframe style="border:0;width:1000px;height:700px" src="${embeddedUrl}"></iframe>`;
    await f.page.setContent(null, f.urls[0] + '/page', false);
    await f.toolbar();
    const embedded = (await f.loaded()).find((frame) => frame.url === embeddedUrl).frameId;
    await f.waitInFrame(embedded, 'Boolean(panel)');
    await f.play(embedded);
    const rendersBefore = f.renders.length;
    await f.inFrame(
      embedded,
      `(() => {const slider=panel.querySelector('.speed');slider.value='1.7';slider.dispatchEvent(new Event('input'));})()`
    );
    await f.waitInFrame(
      embedded,
      `Boolean(CSS.highlights.get('sonora-current-word')?.size || panel.querySelector('.word-mark'))`
    );
    assert.equal(await f.inFrame(embedded, `panel.querySelector('.speed-value').textContent`), '1.7×');
    assert.equal(f.renders.length, rendersBefore, 'changing speed reuses the current synthesis');
    assert.deepEqual(await f.readers(), [embedded]);
    assert.deepEqual(f.worker.errors, []);
    assert.deepEqual(f.page.errors, []);
  });
});
