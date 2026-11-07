const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, longChatHtml, waitFor } = require('./helpers/browser');
const { heavyChatHtml } = require('./helpers/chatgpt');
const { install, chat, settle } = require('./helpers/highlight');
const { install: installMetrics } = require('./helpers/scroll');
const { install: installContainment, chat: containmentChat, positions } = require('./helpers/containment');
test('ChatGPT chrome mutations do not rediscover turns or invalidate the spoken word', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await installMetrics(page);
  await page.evaluate(`(() => {
    const conversation = document.querySelector('[aria-label="Conversation"]');
    const turn = document.querySelector('article');
    for (let at = 0; at < 100; at++) {
      const bar = document.createElement('div'); bar.setAttribute('role', 'toolbar'); bar.innerHTML = '<button>Copy response</button>';  turn.append(bar); bar.remove();
      const wrapper = document.createElement('div'); wrapper.innerHTML = '<div> <button>Copy</button> <button>More</button> </div>'; turn.append(wrapper); wrapper.remove();
      const tooltip = document.createElement('div'); tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = 'More actions'; conversation.append(tooltip); tooltip.remove();
      const status = document.createElement('span'); status.setAttribute('aria-live', 'polite'); status.textContent = 'Updated'; conversation.append(status); status.remove();
    }
    const sidebar = document.createElement('aside'); sidebar.innerHTML = '<p>Sidebar content.</p>'; document.body.append(sidebar); sidebar.firstChild.textContent = 'Sidebar updated.';
    const form = document.createElement('form'); form.innerHTML = '<textarea>Composer</textarea>'; conversation.append(form);
    const time = document.createElement('time'); time.textContent = 'Now'; turn.append(time); time.firstChild.appendData(' updated');
  })()`);
  await settle(page);
  assert.deepEqual(await page.evaluate('({visibleChecks, reads, invalidations})'), {
    visibleChecks: 0,
    reads: 0,
    invalidations: 0
  });
  assert.equal(await page.evaluate('observations.some(options => options.body && options.subtree)'), false);
  assert.deepEqual(page.errors, []);
});

test('turn containment preserves the viewport anchor, native find and distant code clicks', async (t) => {
  const page = await browser(t, heavyChatHtml(600));
  if (!page) return;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  const anchor = await page.evaluate(`(async () => {
    const scroller = document.querySelector('#chat-scroll'); scroller.scrollTop = scroller.scrollHeight / 2;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const turn = document.elementFromPoint(550, 400).closest('article');
    window.anchorTurn = turn;
    return {id: turn.dataset.testid, top: turn.getBoundingClientRect().top};
  })()`);
  await installMetrics(page);
  const top = await page.evaluate('anchorTurn.getBoundingClientRect().top');
  assert(Math.abs(top - anchor.top) < 5, JSON.stringify({ anchor, top }));
  assert.equal(await page.evaluate(`window.find('FindTheDistantNeedle', false, false, true)`), true);
  const found = await page.evaluate(`getSelection().anchorNode.parentElement.closest('article').dataset.testid`);
  assert.equal(found, 'conversation-turn-598');
  await page.evaluate(
    `getSelection().removeAllRanges(); window.renderWords = true; document.querySelector('#text-598').click()`
  );
  assert.match(
    await page.evaluate(`messages.find(message => message.type === 'sonora-render')?.text`),
    /^FindTheDistantNeedle/
  );
  await settle(page);
  assert.equal(await page.evaluate(`panel.querySelector('.word-mark')?.dataset.word`), 'Find');
  await page.evaluate(`panel.querySelector('.stop').click()`);
  const point = await page.evaluate(`(async () => {
    const span = document.querySelector('[data-testid="conversation-turn-595"] pre code .variable');
    span.scrollIntoView({block: 'center'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = span.getBoundingClientRect(); return {x: rect.left + 3, y: rect.top + 8};
  })()`);
  await page.evaluate('window.beforeCodeClick = messages.length');
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point
  });
  assert.equal(
    await page.evaluate(`messages.slice(beforeCodeClick).find(message => message.type === 'sonora-render')?.text`),
    'const value0 = calculate(0);'
  );
  await page.evaluate(
    `window.closeTop = document.querySelector('[data-testid="conversation-turn-595"]').getBoundingClientRect().top`
  );
  const closePoint = await page.evaluate(
    `(() => { const rect = panel.querySelector('.close').getBoundingClientRect(); return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}; })()`
  );
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...closePoint
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...closePoint
  });
  assert.equal(await page.evaluate(`document.querySelector('#sonora-overlay-root')`), null);
  const closeDelta = await page.evaluate(
    `Math.abs(document.querySelector('[data-testid="conversation-turn-595"]').getBoundingClientRect().top - closeTop)`
  );
  assert(closeDelta < 5, 'closing must preserve the viewport: ' + closeDelta);
  assert.deepEqual(page.errors, []);
});

test('reading reveals skipped turns and user scrolling suspends automatic following', async (t) => {
  const page = await browser(t, longChatHtml(500));
  if (!page) return;
  await installMetrics(page);
  await page.evaluate(`document.querySelector('[data-testid="conversation-turn-490"] p').click()`);
  await settle(page);
  assert.equal(
    await page.evaluate(
      `(() => { const rect = document.querySelector('[data-testid="conversation-turn-490"] p').getBoundingClientRect(); return rect.top >= 0 && rect.bottom < innerHeight; })()`
    ),
    true
  );
  await page.evaluate(`scrollTo(0, 0)`);
  await settle(page);
  const requests = await page.evaluate(`messages.filter(message => message.type === 'sonora-render').length`);
  await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
  await settle(page);
  assert.equal(await page.evaluate('scrollY'), 0);
  assert(await page.evaluate(`messages.filter(message => message.type === 'sonora-render').length > ${requests}`));
  assert.deepEqual(page.errors, []);
});

test('scrolling freezes visual progress updates while playback continues, then catches up', async (t) => {
  const page = await browser(t, longChatHtml(20));
  if (!page) return;
  await installMetrics(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.startsWith('Playing')`);
  await page.evaluate(`(() => {
    const audio = panel.querySelector('audio');
    Object.defineProperty(audio, 'duration', {value: 4});
    Object.defineProperty(audio, 'currentTime', {value: 1, writable: true});
    audio.dispatchEvent(new Event('timeupdate'));
    window.progressBeforeScroll = panel.querySelector('.track i').style.transform;
    document.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100}));
    audio.currentTime = 2;
    audio.dispatchEvent(new Event('timeupdate'));
  })()`);
  assert.equal(await page.evaluate(`panel.querySelector('.track i').style.transform === progressBeforeScroll`), true);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /^Playing/);
  await settle(page);
  await page.evaluate(
    `panel.querySelector('audio').dispatchEvent(new Event('timeupdate')); new Promise(resolve => requestAnimationFrame(resolve))`
  );
  assert.equal(await page.evaluate(`panel.querySelector('.track i').style.transform === progressBeforeScroll`), false);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /^Playing/);
  assert.deepEqual(page.errors, []);
});

test('moving the conversation preserves observation of subsequent root replacement', async (t) => {
  const page = await browser(t, longChatHtml(5));
  if (!page) return;
  await installMetrics(page);
  await page.evaluate(`(() => {
    const conversation = document.querySelector('[aria-label="Conversation"]');
    const group = document.createElement('section'), holder = document.createElement('div');
    conversation.replaceWith(group); group.append(holder); holder.append(conversation);
  })()`);
  await page.evaluate(`(() => {
    const previous = document.querySelector('[aria-label="Conversation"]');
    const holder = previous.parentElement;
    const replacement = document.createElement('div');
    replacement.innerHTML = '<div role="region" aria-label="Conversation"><article data-testid="conversation-turn-0"><p id="moved-replacement">Replacement after moving the conversation.</p></article></div>';
    holder.replaceWith(replacement);
  })()`);
  await settle(page);
  await page.evaluate(`document.querySelector('#moved-replacement').click()`);
  assert.equal(
    await page.evaluate(`messages.find(message => message.type === 'sonora-render')?.text`),
    'Replacement after moving the conversation.'
  );
  assert.deepEqual(page.errors, []);
});
test('live regions inside answers refresh prose and code', async (t) => {
  for (const kind of ['live prose', 'live code'])
    await t.test(kind, async (t) => {
      const code = kind === 'live code';
      const html = code
        ? '<pre><code><span id="answer-text" aria-live="polite">alpha();\nbeta();</span></code></pre>'
        : '<div aria-live="polite"><div id="answer-text">Original answer.</div></div>';
      const page = await browser(t, chat(html));
      if (!page) return;
      await install(page);
      await page.evaluate(
        `document.querySelector('#answer-text').append(${JSON.stringify(code ? '\ngamma();' : ' New streamed text.')})`
      );
      await settle(page);
      if (code) {
        const point = await page.evaluate(
          `(() => { const node = document.querySelector('#answer-text').lastChild; const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, node.length); const rect = range.getBoundingClientRect(); return {x: rect.left + 3, y: rect.top + 8}; })()`
        );
        await page.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...point
        });
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          ...point
        });
      } else await page.evaluate(`document.querySelector('#answer-text').click()`);
      await page.evaluate('new Promise(resolve => setTimeout(resolve, 0))');
      const spoken = await page.evaluate(
        `messages.filter(message => message.type === 'sonora-render').map(message => message.text).join(' ')`
      );
      assert.equal(spoken, code ? 'gamma();' : 'Original answer. New streamed text.');
      assert.deepEqual(page.errors, []);
    });
});

test('revealing a subtree invalidates text edited while it was hidden', async (t) => {
  const page = await browser(t, chat('<div id="wrapper"><p>Original before regeneration.</p></div>'));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('#wrapper').hidden = true`);
  await settle(page);
  await page.evaluate(`document.querySelector('p').textContent = 'Edited during regeneration.'`);
  await settle(page);
  await page.evaluate(`document.querySelector('#wrapper').hidden = false`);
  await settle(page);
  await page.evaluate(`document.querySelector('p').click()`);
  assert.equal(
    await page.evaluate(`messages.find(message => message.type === 'sonora-render')?.text`),
    'Edited during regeneration.'
  );
  assert.deepEqual(page.errors, []);
});

test('containment preserves a nested scrollport anchor on open and close', async (t) => {
  const html = `<style>html,body{margin:0;height:100%;overflow:hidden}#scroller{height:100vh;overflow:auto;overflow-anchor:auto}article{padding:20px;box-sizing:border-box}p{margin:0;font:20px/30px sans-serif}</style><main id="scroller"><div role="region" aria-label="Conversation">${Array.from({ length: 200 }, (_, at) => `<article data-testid="conversation-turn-${at}"><p>${('Turn ' + at + ' long content. ').repeat(at % 7 === 0 ? 400 : 2)}</p></article>`).join('')}</div></main>`;
  const page = await browser(t, html);
  if (!page) return;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  const before = await page.evaluate(
    `(async () => { scroller.scrollTop = scroller.scrollHeight / 2; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); window.anchor = document.elementFromPoint(500, 450).closest('article'); return anchor.getBoundingClientRect().top; })()`
  );
  await install(page, null, 'turn');
  await settle(page);
  assert(
    Math.abs((await page.evaluate('anchor.getBoundingClientRect().top')) - before) < 3,
    'opening must preserve the inner viewport'
  );
  await page.evaluate(`panel.querySelector('.close').click()`);
  await settle(page);
  assert(
    Math.abs((await page.evaluate('anchor.getBoundingClientRect().top')) - before) < 3,
    'closing must preserve the inner viewport'
  );
  assert.equal(await page.evaluate('scrollY'), 0);
  assert.deepEqual(page.errors, []);
});

test('chrome layout changes reposition the same spoken word without rediscovering text', async (t) => {
  const page = await browser(t, chat('<p>Read this word slowly.</p>'));
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await settle(page);
  const before = await page.evaluate(`parseFloat(panel.querySelector('.word-mark').style.top)`);
  await page.evaluate(
    `(() => { window.discoveryChecks = 0; const visible = SonoraPassages.visibleBlock; SonoraPassages.visibleBlock = (...args) => { discoveryChecks++; return visible(...args); }; const bar = document.createElement('div'); bar.id = 'toolbar'; bar.setAttribute('role', 'toolbar'); bar.style.height = '120px'; bar.innerHTML = '<button>Copy</button>'; document.querySelector('p').before(bar); })()`
  );
  await settle(page);
  const top = async () =>
    page.evaluate(
      `(() => { const range = document.createRange(); range.setStart(document.querySelector('p').firstChild, 0); range.setEnd(document.querySelector('p').firstChild, 4); return {word: range.getBoundingClientRect().top, highlight: parseFloat(panel.querySelector('.word-mark').style.top)}; })()`
    );
  let position = await top();
  assert(Math.abs(position.word - before - 120) < 2);
  assert(Math.abs(position.word - position.highlight) < 2, JSON.stringify(position));
  await page.evaluate(`document.querySelector('#toolbar').style.height = '240px'`);
  await settle(page);
  position = await top();
  assert(Math.abs(position.word - position.highlight) < 2, JSON.stringify(position));
  assert.equal(await page.evaluate('discoveryChecks'), 0);
  assert.deepEqual(page.errors, []);
});

test('nested auto-follow and wheel bursts use the conversation scrollport', async (t) => {
  const html =
    '<style>html,body{margin:0;height:100%;overflow:hidden}#scroller{height:100vh;overflow:auto}article{padding:30px}p{font:20px/28px sans-serif}</style><main id="scroller"><div role="region" aria-label="Conversation">' +
    Array.from(
      { length: 200 },
      (_, at) =>
        '<article data-testid="conversation-turn-' +
        at +
        '"><p id="p' +
        at +
        '">Read this paragraph ' +
        at +
        '.</p></article>'
    ).join('') +
    '</div></main>';
  const page = await browser(t, html);
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('#p150').click()`);
  await settle(page);
  const followed = await page.evaluate(
    `(() => { const rect = document.querySelector('#p150').getBoundingClientRect(); return {visible: rect.top >= 0 && rect.bottom <= innerHeight, inner: scroller.scrollTop, outer: scrollY}; })()`
  );
  assert(followed.visible && followed.inner > 0 && followed.outer === 0, JSON.stringify(followed));
  const during = await page.evaluate(`(async () => {
    scroller.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100}));
    wordUpdates = 0;
    for (let at = 0; at < 12; at++) { await new Promise(resolve => setTimeout(resolve, 40)); scroller.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100})); }
    return wordUpdates;
  })()`);
  assert.equal(during, 0, 'tracking must stay suspended past the first 150 ms');
  await settle(page);
  assert(await page.evaluate('wordUpdates > 0'), 'tracking resumes after the burst');
  assert.deepEqual(page.errors, []);
});
test('containment preserves fixed and sticky controls outside and inside the turn wrapper', async (t) => {
  for (const location of ['region', 'stack', 'turn'])
    await t.test(location, async (t) => {
      const page = await browser(t, containmentChat(location, 'both'));
      if (!page) return;
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      });
      await page.evaluate(
        'scroller.scrollTop = 2500; window.originalTurns = [...document.querySelectorAll("article")]'
      );
      const before = await page.evaluate(positions);
      await page.evaluate('scroller.scrollTop = 2550');
      const afterScroll = await page.evaluate(positions);
      await page.evaluate('scroller.scrollTop = 2500');
      await installContainment(page);
      assert.deepEqual(await page.evaluate(positions), before, 'opening preserves both controls');
      const styles = await page.evaluate(
        `({root: getComputedStyle(document.querySelector('[aria-label="Conversation"]')).contentVisibility, turns: getComputedStyle(document.querySelector('#turns')).contentVisibility})`
      );
      assert.equal(styles.root, 'visible');
      assert.equal(styles.turns, location === 'region' ? 'auto' : 'visible');
      assert(
        await page.evaluate('[...document.querySelectorAll("article")].every((node, at) => node === originalTurns[at])')
      );
      await page.evaluate('scroller.scrollTop = 2550');
      assert.deepEqual(
        await page.evaluate(positions),
        afterScroll,
        'scrolling preserves viewport and sticky positioning'
      );
      await page.evaluate('panel.querySelector(".close").click()');
      assert.deepEqual(await page.evaluate(positions), afterScroll, 'closing preserves both controls');
      assert.equal(
        await page.evaluate('getComputedStyle(document.querySelector("#turns")).contentVisibility'),
        'visible'
      );
      assert.deepEqual(page.errors, []);
    });
});

test('containment falls back when an existing control becomes fixed', async (t) => {
  const page = await browser(
    t,
    containmentChat('none') + '<style>.floating{position:fixed;bottom:25px;left:30px;height:24px}</style>'
  );
  if (!page) return;
  await page.evaluate(`(() => {
    const control = document.createElement('button'); control.id = 'late'; control.textContent = 'Controls';
    document.querySelector('#turns').prepend(control); scroller.scrollTop = 2500;
  })()`);
  await installContainment(page);
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#turns")).contentVisibility'), 'auto');
  await page.evaluate(`document.querySelector('#late').className = 'floating'`);
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#turns")).contentVisibility'), 'visible');
  const before = await page.evaluate('document.querySelector("#late").getBoundingClientRect().top');
  await page.evaluate('panel.querySelector(".close").click()');
  assert.equal(await page.evaluate('document.querySelector("#late").getBoundingClientRect().top'), before);
  assert.equal(
    await page.evaluate('document.querySelector("#late").getBoundingClientRect().bottom'),
    (await page.evaluate('innerHeight')) - 25
  );
  assert.deepEqual(page.errors, []);
});

const { install: installArticle } = require('./helpers/overlay');
test('generic Claude toolbar traffic performs no discovery and edits touch only one message', async (t) => {
  const { claudeHtml } = require('./helpers/claude');
  const page = await browser(t, claudeHtml(), 'https://claude.ai/chat/mutations');
  if (!page) return;
  await installArticle(page);
  await page.evaluate(
    `(() => {window.visits=[];const visible=SonoraPassages.visibleBlock;SonoraPassages.visibleBlock=(node,...args)=>{visits.push(node.textContent);return visible(node,...args);};for(let at=0;at<12;at++)document.querySelector('#ui').textContent='Copy '+at;})()`
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(await page.evaluate('visits'), []);
  await page.evaluate(`document.querySelectorAll('p')[999].firstChild.appendData(' Changed.')`);
  await waitFor(page, 'visits.length > 0');
  assert((await page.evaluate('visits')).every((text) => text.includes('Message 999')));
});
