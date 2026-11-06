const test = require('node:test');
const assert = require('node:assert/strict');
const { reader } = require('./helpers/reader');
const { waitFor } = require('./helpers/browser');

test('reader retains chapter text and paragraph click/keyboard targets during local and browser playback (audit 10)', async t => {
  const page = await reader(t);
  if (!page) return;
  await page.evaluate(`window.originalParagraphs = [...els.bookText.children]; window.originalText = els.bookText.textContent; listenChapter(); renders[0].complete({words: [{textOffset: 0, length: 9, start: 0, end: 1}]});`);
  await waitFor(page, 'state.playing');
  assert.equal(await page.evaluate('els.bookText.textContent === originalText'), true);
  assert.equal(await page.evaluate('originalParagraphs.every((node, i) => node === els.bookText.children[i])'), true);
  assert.equal(await page.evaluate('els.bookText.querySelectorAll("[data-passage][tabindex]").length'), 4);
  await page.evaluate('highlightWord(.5)');
  assert.equal(await page.evaluate(`[...CSS.highlights.get('sonora-word')][0].toString()`), 'Paragraph');
  await page.evaluate(`originalParagraphs[2].click()`);
  assert.match(await page.evaluate('renders.at(-1).text'), /^Paragraph 2\./);
  await page.evaluate(`originalParagraphs[3].dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}))`);
  assert.match(await page.evaluate('renders.at(-1).text'), /^Paragraph 3\./);
  await page.evaluate(`els.voiceSelect.value = 'browser'; els.voiceSelect.dispatchEvent(new Event('change')); originalParagraphs[1].dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true, cancelable: true})); utterances.at(-1).onboundary({charIndex: 3, charLength: 5});`);
  assert.equal(await page.evaluate('els.bookText.textContent === originalText && originalParagraphs.every((node, i) => node === els.bookText.children[i])'), true);
  assert.equal(await page.evaluate(`[...CSS.highlights.get('sonora-word')][0].toString() === utterances.at(-1).text.slice(3, 8)`), true);
  assert.deepEqual(page.errors, []);
});

test('Pause and Resume use the active engine during automatic browser fallback (audit 11)', async t => {
  const page = await reader(t, { ready: false });
  if (!page) return;
  await page.evaluate(`els.listen.click(); window.localPauses = audioPauses; els.listen.click()`);
  assert.equal(await page.evaluate('synthesisCalls.at(-1)'), 'pause');
  assert.equal(await page.evaluate('audioPauses'), await page.evaluate('localPauses'));
  await page.evaluate('els.listen.click()');
  assert.equal(await page.evaluate('synthesisCalls.at(-1)'), 'resume');
  await page.evaluate('stopPlayback()');
  assert.equal(await page.evaluate('synthesisCalls.at(-1)'), 'cancel');
});

test('local reader renders just one chunk ahead and consumes it at the boundary (audit 19)', async t => {
  const page = await reader(t);
  if (!page) return;
  await page.evaluate('listenChapter(); renders[0].complete()');
  await waitFor(page, 'state.playing');
  assert.equal(await page.evaluate('renders.length'), 2, 'next render must start before current audio ends');
  await page.evaluate('renders[1].complete()');
  await page.evaluate('Promise.resolve()');
  assert.equal(await page.evaluate('renders.length'), 2, 'no unbounded prefetch');
  await page.evaluate(`els.audio.dispatchEvent(new Event('ended'))`);
  await waitFor(page, 'audioPlays === 2');
  assert.equal(await page.evaluate('renders.length'), 3);
  assert.equal(await page.evaluate('renders[2].text === state.queue[2]'), true);
});

for (const action of ['seek', 'stop', 'voice', 'speed', 'chapter', 'reset', 'pagehide']) {
  test(`reader cancels one-ahead render on ${action} and ignores stale completion (audit 19)`, async t => {
    const page = await reader(t);
    if (!page) return;
    await page.evaluate('ignoreAbort = true; listenChapter(); renders[0].complete()');
    await waitFor(page, 'state.playing');
    assert.equal(await page.evaluate('renders.length'), 2);
    await page.evaluate(`window.prefetch = renders[1]; window.playsBefore = audioPlays; ${({
      seek: 'playPassage(2)', stop: 'stopPlayback()',
      voice: "els.voiceSelect.value = 'af_bella'; els.voiceSelect.dispatchEvent(new Event('change'))",
      speed: "els.audio.playbackRate = 1.5; els.audio.dispatchEvent(new Event('ratechange'))",
      chapter: 'renderChapter()', reset: 'els.reset.click()', pagehide: "window.dispatchEvent(new Event('pagehide'))"
    })[action]}; prefetch.complete();`);
    assert.equal(await page.evaluate('prefetch.aborted'), true);
    assert.equal(await page.evaluate('audioPlays'), await page.evaluate('playsBefore'));
    if (action === 'seek') assert.match(await page.evaluate('renders.at(-1).text'), /^Paragraph 2\./);
    if (action === 'speed') {
      await page.evaluate(`els.audio.dispatchEvent(new Event('ended'))`);
      assert.equal(await page.evaluate('renders.at(-1) !== prefetch && renders.at(-1).text === prefetch.text'), true);
    }
    assert.deepEqual(page.errors, []);
  });
}

test('pending render has a visible Cancel action; next click aborts and a late result cannot play (audit 25)', async t => {
  const page = await reader(t);
  if (!page) return;
  await page.evaluate('ignoreAbort = true; els.listen.click()');
  assert.match(await page.evaluate('els.listen.textContent'), /Cancel/);
  assert.equal(await page.evaluate('els.listen.getAttribute("aria-busy")'), 'true');
  await page.evaluate('els.listen.click()');
  assert.equal(await page.evaluate('renders[0].aborted'), true);
  await page.evaluate('renders[0].complete()');
  await page.evaluate('Promise.resolve()');
  assert.equal(await page.evaluate('audioPlays'), 0);
  assert.equal(await page.evaluate('state.playing'), false);
  assert.equal(await page.evaluate('els.listen.getAttribute("aria-busy")'), 'false');
  await page.evaluate('els.listen.click()');
  assert.equal(await page.evaluate('renders.length'), 2, 'next click starts a new render, never a stale resume');
});

for (const event of ['voice', 'speed']) {
  test(`changing ${event} cancels current pending synthesis as well as speculation`, async t => {
    const page = await reader(t);
    if (!page) return;
    await page.evaluate(`ignoreAbort = true; els.listen.click(); ${event === 'voice'
      ? "els.voiceSelect.value = 'af_bella'; els.voiceSelect.dispatchEvent(new Event('change'))"
      : "els.audio.playbackRate = 1.5; els.audio.dispatchEvent(new Event('ratechange'))"}; renders[0].complete();`);
    assert.equal(await page.evaluate('renders[0].aborted'), true);
    assert.equal(await page.evaluate('audioPlays'), 0);
    assert.equal(await page.evaluate('state.playback'), 'idle');
  });
}

test('local pause/resume reuses audio; cancelling at a pending chunk boundary aborts that render', async t => {
  const page = await reader(t);
  if (!page) return;
  await page.evaluate('els.listen.click(); renders[0].complete()');
  await waitFor(page, 'state.playing');
  await page.evaluate('els.listen.click()');
  assert.equal(await page.evaluate('state.playback'), 'paused');
  await page.evaluate('els.listen.click()');
  await waitFor(page, 'state.playing');
  assert.equal(await page.evaluate('renders.length'), 2);
  await page.evaluate(`els.audio.dispatchEvent(new Event('ended'))`);
  assert.match(await page.evaluate('els.listen.textContent'), /Cancel/);
  await page.evaluate('els.listen.click()');
  assert.equal(await page.evaluate('renders[1].aborted'), true);
  assert.equal(await page.evaluate('audioPlays'), 2);
  assert.equal(await page.evaluate('state.playback'), 'idle');
});

test('a failed prefetch is handled and reported only when that passage becomes current', async t => {
  const page = await reader(t);
  if (!page) return;
  await page.evaluate(`listenChapter(); renders[0].complete()`);
  await waitFor(page, 'state.playing');
  await page.evaluate(`renders[1].fail('Synthetic render failure')`);
  assert.equal(await page.evaluate('state.playing'), true);
  assert.equal(await page.evaluate('els.toast.textContent'), '');
  await page.evaluate(`els.audio.dispatchEvent(new Event('ended'))`);
  await waitFor(page, "els.toast.textContent === 'Synthetic render failure'");
  assert.equal(await page.evaluate('state.playback'), 'idle');
  assert.deepEqual(page.errors, []);
});

test('stale browser callbacks and rejected local play promises cannot revive a stopped session', async t => {
  const page = await reader(t, { ready: false });
  if (!page) return;
  await page.evaluate('listenChapter(); window.oldUtterance = utterances.at(-1); stopPlayback(); oldUtterance.onstart?.(); oldUtterance.onend?.(); oldUtterance.onerror?.()');
  assert.equal(await page.evaluate('state.playing'), false);
  assert.equal(await page.evaluate('utterances.length'), 1);
  await page.evaluate(`state.voiceReady = true; els.audio.play = () => new Promise((resolve, reject) => { window.rejectPlay = reject; }); listenChapter(); renders[0].complete()`);
  await waitFor(page, 'Boolean(window.rejectPlay)');
  await page.evaluate(`stopPlayback(); listenChapter(); rejectPlay(new Error('old playback failed'))`);
  assert.match(await page.evaluate('els.listen.textContent'), /Cancel/);
  assert.equal(await page.evaluate('els.toast.textContent'), '');
});
