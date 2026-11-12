const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, longChatHtml, waitFor } = require('./helpers/browser');
const { install, finishPlayback } = require('./helpers/discovery');
const { install: installLarge } = require('./helpers/large-page');
const { install: installRedraw } = require('./helpers/redraw');
const { install: installArticle } = require('./helpers/overlay');
const lastRender = `messages.findLast(message=>message.type==='sonora-render')?.text`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('continuous Claude reading includes paragraphs appended while the answer streams', async (t) => {
  const paragraphs = [
    'Opening answer.',
    'Second paragraph.',
    'Third paragraph.',
    'Fourth paragraph.',
    'Fifth paragraph.'
  ];
  const page = await browser(
    t,
    '<main><div class="font-claude-response" id="answer">' +
      paragraphs.map((text) => '<p>' + text + '</p>').join('') +
      '</div></main>',
    'https://claude.ai/chat/stream'
  );
  if (!page) return;
  await installArticle(page);
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, 'played.length === 1');
  const tail = 'New paragraph in the streamed answer.';
  await page.evaluate(`document.querySelector('#answer').insertAdjacentHTML('beforeend', '<p>${tail}</p>')`);
  await waitFor(page, `/^6 clickable blocks/.test(panel.querySelector('.meta').textContent)`);
  for (let at = 1; at < paragraphs.length; at++) {
    await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
    await waitFor(
      page,
      `played.length > ${at} || panel.querySelector('.status span').textContent.includes('complete')`
    );
  }
  // The old iterator is now exhausted; its last audio is already buffered.
  const later = 'The final streamed paragraph also belongs in the queue.';
  await page.evaluate(`document.querySelector('#answer').insertAdjacentHTML('beforeend', '<p>${later}</p>')`);
  await waitFor(page, `/^7 clickable blocks/.test(panel.querySelector('.meta').textContent)`);
  for (let at = paragraphs.length; at <= paragraphs.length + 2; at++) {
    await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
    await waitFor(
      page,
      `played.length > ${at} || panel.querySelector('.status span').textContent.includes('complete')`
    );
  }
  assert.deepEqual(await page.evaluate('played'), [...paragraphs, tail, later]);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /complete/);
  assert.deepEqual(page.errors, []);
});

test('the short opening prefetches its remainder while the first audio download is pending', async (t) => {
  const text = Array.from({ length: 70 }, (_, at) => 'word' + at).join(' ') + '. Following sentence.';
  const page = await browser(t, '<main><p>' + text + '</p></main>');
  if (!page) return;
  await installArticle(page);
  const rendered = await page.evaluate(`(() => {
    window.pending = new Map();
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => {
      if (message.type === 'sonora-render') {
        requests.push(message); pending.set(message.requestId, callback); return;
      }
      if (message.type === 'sonora-cancel-render') {
        pending.get(message.requestId)?.({ok:false,error:'cancelled'}); pending.delete(message.requestId);
      }
      send(message, callback);
    };
    document.querySelector('p').click();
    const first = requests.find(item => item.type === 'sonora-render');
    receive({type:'sonora-render-ready',requestId:first.requestId});
    return requests.filter(item => item.type === 'sonora-render').map(item => item.text);
  })()`);
  assert.equal(rendered[0].split(/\s+/).length, 25);
  assert.equal(rendered.join(' '), text);
  assert.deepEqual(await page.evaluate('played'), [], 'synthesis readiness must not wait for audio playback');
  await page.evaluate(`panel.querySelector('.stop').click()`);
  assert.equal(await page.evaluate('pending.size'), 0, 'Stop cancels both outstanding downloads');
  assert.deepEqual(page.errors, []);
});

test('playback waits for ongoing discovery and reads the entire code block and following paragraph', async (t) => {
  const lines = Array.from({ length: 2000 }, (_, at) => 'const value' + at + ' = ' + at + ';');
  const html =
    '<main><pre><code>' +
    lines.map((line) => '<span>' + line + '</span>').join('\n') +
    '</code></pre><p>Final paragraph.</p></main>';
  const page = await browser(t, html);
  if (!page) return;
  await install(page);
  await page.evaluate(`autoPlayback = true; document.querySelector('pre').click(); startIndex()`);
  const result = await finishPlayback(page);
  assert.equal(result.completedBeforeIndexing, false, 'a temporary empty buffer is not completion');
  assert.equal(result.indexed, true);
  assert(result.playedBeforeIndexing > 0, 'playback must race with real discovery batches');
  assert.deepEqual(result.spoken, [...lines, 'Final paragraph.']);
  assert.deepEqual(page.errors, []);
});

test('partial Unicode extraction resumes through the full paragraph without corrupting its seam', async (t) => {
  const text = 'word '.repeat(479) + 'abcd😀 ' + 'rest '.repeat(1000) + 'Final sentence.';
  const page = await browser(t, '<meta charset="utf-8"><main><p>' + text + '</p></main>');
  if (!page) return;
  await install(page);
  await page.evaluate(`document.querySelector('p').click(); startIndex()`);
  await page.evaluate('window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`autoPlayback = true; panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
  const result = await finishPlayback(page, 3000);
  assert.equal(result.spoken.join(' '), text);
  assert(!result.spoken.join('').includes('\ufffd'));
  assert.deepEqual(page.errors, []);
});

test('multiple early selections keep continuous playback in document order during discovery', async (t) => {
  const page = await browser(t, longChatHtml(100));
  if (!page) return;
  await install(page);
  await page.evaluate(`(() => {
    document.querySelector('[data-testid="conversation-turn-80"] p').click();
    spoken.length = 0; autoPlayback = true;
    document.querySelector('[data-testid="conversation-turn-0"] p').click();
    startIndex();
  })()`);
  const result = await finishPlayback(page);
  const expected = [];
  for (let turn = 0; turn < 100; turn++) {
    expected.push('Turn ' + turn + ' says answer() aloud.');
    if (turn % 5 === 0)
      for (let line = 0; line < 5; line++) expected.push('const value' + line + ' = ' + (turn + line) + ';');
  }
  assert(result.playedBeforeIndexing > 0, 'audio must advance before discovery completes');
  assert.equal(result.completedBeforeIndexing, false);
  assert.deepEqual(result.spoken, expected);
  assert.deepEqual(page.errors, []);
});

test('code clicks ignore hidden labels and line numbers when selecting their visible line', async (t) => {
  const html =
    '<style>code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code><span aria-hidden="true" style="display:none">Hidden Copy code label</span><span>alpha();</span>\n<span aria-hidden="true" style="display:none">Line 2</span><span>beta();</span>\n<span>gamma();</span></code></pre></main>';
  const page = await browser(t, html);
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  for (const [line, expected] of [
    [0, 'alpha();'],
    [1, 'beta();'],
    [2, 'gamma();']
  ]) {
    const point = await page.evaluate(
      `(() => { const r = document.querySelector('code').getBoundingClientRect(); return {x: r.left + 3, y: r.top + ${line} * 24 + 12}; })()`
    );
    const before = await page.evaluate('messages.length');
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
      await page.evaluate(`messages.slice(${before}).find(item => item.type === 'sonora-render')?.text`),
      expected
    );
    await page.evaluate(`panel.querySelector('.stop').click()`);
  }
  assert.deepEqual(page.errors, []);
});

test('semantic language labels beside copy controls are excluded from continuous reading', async (t) => {
  const page = await browser(
    t,
    '<main><p>Read this explanation.</p><div><h3>javascript</h3><button>Copy code</button><pre><code>alpha();\nbeta();</code></pre></div><div><p>python</p><button>Copy</button><pre><code>print(1)</code></pre></div><p>Read the conclusion.</p></main>'
  );
  if (!page) return;
  await install(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`autoPlayback = true; document.querySelector('p').click()`);
  const result = await finishPlayback(page);
  assert.deepEqual(result.spoken, [
    'Read this explanation.',
    'alpha();',
    'beta();',
    'print(1)',
    'Read the conclusion.'
  ]);
  assert.deepEqual(page.errors, []);
});

test('pausing while waiting for discovery prevents automatic resume and resumes at the next passage', async (t) => {
  const lines = Array.from({ length: 500 }, (_, at) => 'call' + at + '();');
  const page = await browser(
    t,
    '<main><p>First passage.</p><pre><code>' +
      lines.map((line) => '<span>' + line + '</span>').join('\n') +
      '</code></pre><p>Last passage.</p></main>'
  );
  if (!page) return;
  await install(page);
  await page.evaluate(`autoPlayback = true; document.querySelector('p').click()`);
  await waitFor(page, `panel.querySelector('.status span').textContent.includes('Finding the next')`);
  assert.match(await page.evaluate(`panel.querySelector('.status span').textContent`), /Finding the next/);
  assert.equal(await page.evaluate('indexed'), false);
  await page.evaluate(`panel.querySelector('.play').click(); startIndex(); window.__sonoraOverlay.whenIndexed`);
  await waitFor(page, `panel.querySelector('.status span').textContent === 'Paused'`);
  assert.equal(await page.evaluate(`panel.querySelector('.status span').textContent`), 'Paused');
  assert.deepEqual(await page.evaluate('spoken'), ['First passage.']);
  await page.evaluate(`panel.querySelector('.play').click()`);
  const result = await finishPlayback(page);
  assert.deepEqual(result.spoken, ['First passage.', ...lines, 'Last passage.']);
  assert.deepEqual(page.errors, []);
});
test('controls and a clicked turn work before the rest of a 2,000-turn page is indexed', async (t) => {
  const page = await browser(t, longChatHtml(2000));
  if (!page) return;
  await installLarge(page);
  assert.equal(await page.evaluate(`Boolean(panel.querySelector('.controls'))`), true);
  assert.equal(await page.evaluate(`document.querySelectorAll('.sonora-readable-block').length`), 0);
  await page.evaluate(`document.querySelector('[data-testid="conversation-turn-1999"] p').click()`);
  assert.match(await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`), /Turn 1999/);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  assert.match(await page.evaluate(`panel.querySelector('.meta').textContent`), /^2400 clickable blocks/);
  assert.deepEqual(page.errors, []);
});

test('a 50,000-word selection reads through partial extraction without losing words', async (t) => {
  const text = Array.from({ length: 50000 }, (_, at) => 'word' + at).join(' ') + '. Last sentence.';
  const page = await browser(t, '<main><p>' + text + '</p></main>');
  if (!page) return;
  await installLarge(page);
  await page.evaluate('document.querySelector("p").click()');
  assert.equal(
    await page.evaluate(`messages.find(item => item.type === 'sonora-render').text.split(/\\s+/).length`),
    20
  );
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  const result = await page.evaluate(`(async () => {
    for (let at = 0; at < 1000 && !panel.querySelector('.status span').textContent.includes('complete'); at++) {
      panel.querySelector('audio').dispatchEvent(new Event('ended'));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { texts: messages.filter(item => item.type === 'sonora-render').map(item => item.text), status: panel.querySelector('.status span').textContent };
  })()`);
  assert.match(result.status, /complete/);
  assert.equal(result.texts.join(' '), text);
  const replay = await page.evaluate(
    `(() => { const before = messages.length; panel.querySelector('.play').click(); return messages.slice(before).find(item => item.type === 'sonora-render')?.text; })()`
  );
  assert.equal(replay, result.texts[0], 'replay starts at the original selection after compacting the queue');
  assert.deepEqual(page.errors, []);
});

test('a deep code click before indexing selects that line rather than the extracted prefix', async (t) => {
  const code = Array.from({ length: 20000 }, (_, at) => '<span>call' + at + '();</span>').join('\n');
  const page = await browser(
    t,
    '<style>code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code>' +
      code +
      '</code></pre></main>'
  );
  if (!page) return;
  await installLarge(page);
  await page.evaluate(`(() => {
    const span = document.querySelector('code span:nth-of-type(19000)');
    span.scrollIntoView({block: 'center'});
    const rect = span.getBoundingClientRect();
    span.dispatchEvent(new MouseEvent('click', {bubbles: true, button: 0, detail: 1, clientX: rect.left + 10, clientY: rect.top + 8}));
  })()`);
  for (
    let attempt = 0;
    attempt < 100 && !(await page.evaluate(`messages.some(item => item.type === 'sonora-render')`));
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`), 'call18999();');
  assert.deepEqual(page.errors, []);
});

test('clicking deep in an oversized code line selects a bounded chunk containing the clicked word', async (t) => {
  const words = Array.from({ length: 3000 }, (_, at) => 'value' + at);
  const text = words.join(' ');
  const page = await browser(
    t,
    '<style>pre{width:600px;overflow:auto}code{display:block;white-space:pre;font:16px/24px monospace}</style><main><pre><code>' +
      text +
      '</code></pre></main>'
  );
  if (!page) return;
  await installLarge(page);
  await page.evaluate('startIndex(); window.__sonoraOverlay.whenIndexed');
  await page.evaluate(`(() => {
    const code = document.querySelector('code'), offset = code.textContent.indexOf('value2000');
    const range = document.createRange(); range.setStart(code.firstChild, offset); range.setEnd(code.firstChild, offset + 9);
    code.parentElement.scrollLeft = range.getBoundingClientRect().left - 50;
    const rect = range.getBoundingClientRect();
    code.dispatchEvent(new MouseEvent('click', {bubbles: true, button: 0, detail: 1, clientX: rect.left + 20, clientY: rect.top + 8}));
  })()`);
  const spoken = await page.evaluate(`messages.find(item => item.type === 'sonora-render')?.text`);
  assert(spoken?.includes('value2000'), spoken);
  assert(spoken.length <= 1200);
  assert.deepEqual(page.errors, []);
});
test('same-ID turn replacement remains clickable for prose and code', async (t) => {
  const page = await browser(t, longChatHtml(2));
  if (!page) return;
  await installRedraw(page);
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

test('clicking trailing code whitespace starts its visual line', async (t) => {
  const page = await browser(
    t,
    '<style>pre{padding:10px}code{display:block;white-space:pre;font:16px/24px monospace}</style><main><article data-testid="conversation-turn-0"><pre><code>alpha();\nbeta();\ngamma();</code></pre></article></main>'
  );
  if (!page) return;
  await installRedraw(page);
  const bounds = await page.evaluate(
    `(() => { const r = document.querySelector('code').getBoundingClientRect(); return {x: r.left, y: r.top, width: r.width}; })()`
  );
  for (const [line, expected, trailing] of [
    [0, 'alpha();', true],
    [1, 'beta();', true],
    [2, 'gamma();', true],
    [1, 'beta();', false]
  ]) {
    const before = await page.evaluate('messages.length');
    const point = {
      x: bounds.x + (trailing ? Math.min(200, bounds.width - 20) : 2),
      y: bounds.y + line * 24 + 12
    };
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
    await waitFor(page, `messages.slice(${before}).some(message => message.type === 'sonora-render')`);
    assert.equal(await page.evaluate(lastRender), expected);
    await page.evaluate(`panel.querySelector('.stop').click()`);
  }
  await page.evaluate(`document.querySelector('code').textContent = 'alpha();   \\n    beta();\\n  gamma();'`);
  await delay(220);
  const before = await page.evaluate('messages.length');
  const indentation = { x: bounds.x + 2, y: bounds.y + 24 + 12 };
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...indentation
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...indentation
  });
  await waitFor(page, `messages.slice(${before}).some(message => message.type === 'sonora-render')`);
  assert.equal(await page.evaluate(lastRender), 'beta();');
  assert.deepEqual(page.errors, []);
});

test('unscoped ChatGPT additions and streamed edits refresh the reader', async (t) => {
  const page = await browser(t, longChatHtml(2));
  if (!page) return;
  await installRedraw(page);
  await page.evaluate(`(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'outside-turn'; paragraph.textContent = 'New unscoped prose';
    document.querySelector('[aria-label="Conversation"]').append(paragraph);
  })()`);
  await delay(220);
  assert.equal(
    await page.evaluate(`document.querySelector('#outside-turn').classList.contains('sonora-readable-block')`),
    true
  );
  await page.evaluate(`document.querySelector('#outside-turn').click()`);
  assert.equal(await page.evaluate(lastRender), 'New unscoped prose');
  await page.evaluate(
    `panel.querySelector('.stop').click(); document.querySelector('#outside-turn').firstChild.appendData(' with streamed suffix.');`
  );
  await delay(220);
  await page.evaluate(`document.querySelector('#outside-turn').click()`);
  assert.equal(await page.evaluate(lastRender), 'New unscoped prose with streamed suffix.');
  assert.deepEqual(page.errors, []);
});
test('continuous reading prefetches several passages ahead and skips unreadable passages and failed renders', async (t) => {
  const page = await browser(
    t,
    '<main><div class="font-claude-response"><p>Opening answer here.</p><p>[…]</p><p>Second paragraph.</p><p>' + 'x'.repeat(600) +
      '</p><p>Third paragraph.</p><p>Fourth paragraph.</p><p>Fifth paragraph.</p></div></main>',
    'https://claude.ai/chat/prefetch'
  );
  if (!page) return;
  await installArticle(page, { rejectLongTokens: true });
  await page.evaluate(`document.querySelector('p').click()`);
  await waitFor(page, 'played.length === 1');
  await waitFor(page, `requests.filter(m => m.type === 'sonora-render').length >= 4`);
  for (let at = 1; at < 5; at++) {
    await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
    await waitFor(page, `played.length > ${at} || panel.querySelector('.status span').textContent.includes('complete')`);
  }
  const texts = await page.evaluate(`requests.filter(m => m.type === 'sonora-render').map(m => m.text)`);
  assert.ok(!texts.some((text) => !/[\p{L}\p{N}]/u.test(text)), 'unreadable passages never reach the voice');
  assert.deepEqual(await page.evaluate('played.filter(Boolean).map(text => text.slice(0, 6))'),
    ['Openin', 'Second', 'Third ', 'Fourth', 'Fifth ']);
});
test('look-ahead stays within the voice queue limit and treats 429/503 as retry-later, never skipping a passage', async (t) => {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];
  const page = await browser(
    t,
    '<main><div class="font-claude-response">' + names.map((name) => `<p>${name} paragraph says something.</p>`).join('') + '</div></main>',
    'https://claude.ai/chat/queue-limit'
  );
  if (!page) return;
  await installArticle(page);
  // Stub voice: cold start (503), then one worker, the real 6-pending limit
  // (another tab holds 5 slots for a while) and 429 beyond it.
  await page.evaluate(`(() => {
    const began = performance.now(), jobs = []; let busy = false, phantom = 5;
    window.maxPending = 0; window.limited = 0; window.coldRejected = 0;
    setTimeout(() => { phantom = 0; }, 1500);
    const pump = () => {
      if (busy || !jobs.length) return;
      busy = true;
      const job = jobs.shift();
      setTimeout(() => { busy = false; const src = 'audio-' + job.requestId; sources.set(src, job.text); job.done({ ok: true, data: { src, words: [] } }); pump(); }, 20);
    };
    chrome.runtime.sendMessage = (message, done) => {
      requests.push(message);
      if (message.type !== 'sonora-render') return done({ ok: true, data: { ready: true } });
      if (performance.now() - began < 300) { coldRejected++; return done({ ok: false, status: 503, error: 'Sonora is starting.' }); }
      const pending = jobs.length + (busy ? 1 : 0) + phantom;
      if (pending >= 6) { limited++; return done({ ok: false, status: 429, error: 'The local voice queue is full.' }); }
      jobs.push({ requestId: message.requestId, text: message.text, done });
      maxPending = Math.max(maxPending, jobs.length + (busy ? 1 : 0));
      pump();
    };
  })()`);
  await page.evaluate(`document.querySelector('p').click()`);
  for (let at = 1; at <= names.length; at++) {
    await waitFor(page, `played.length >= ${at}`, 15000);
    if (at < names.length) await page.evaluate(`panel.querySelector('audio').dispatchEvent(new Event('ended'))`);
  }
  assert.deepEqual(
    await page.evaluate('played.map(text => text.split(" ")[0])'),
    names,
    'every passage plays in order; none is skipped'
  );
  assert.ok((await page.evaluate('coldRejected')) > 0, 'the cold start rejected requests');
  assert.ok((await page.evaluate('limited')) > 0, 'the full queue answered 429 and was retried');
  assert.ok((await page.evaluate('maxPending')) <= 4, 'one reader keeps at most 4 renders in flight');
});
