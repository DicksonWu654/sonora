const test = require('node:test');
const assert = require('node:assert/strict');
const { reader } = require('./helpers/reader');
const { waitFor } = require('./helpers/browser');

function wav(seconds = 2) {
  const data = Buffer.alloc(44 + Math.round(48000 * seconds));
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return 'data:audio/wav;base64,' + data.toString('base64');
}

async function nativeReader(t, { autoRender = true } = {}) {
  const page = await reader(t, {nativeAudio: true});
  if (!page) return null;
  await page.evaluate(`(() => {
    window.fixtureAudio = ${JSON.stringify(wav())};
    window.mediaEvents = [];
    for (const type of ['playing', 'ended', 'ratechange', 'emptied']) els.audio.addEventListener(type, () => {
      mediaEvents.push({type, rate: els.audio.playbackRate, index: state.queueIndex, playback: state.playback});
    });
    const fetchRender = window.fetch;
    window.fetch = (url, options) => {
      const result = fetchRender(url, options);
      if (${autoRender} && url === '/api/narration/render') renders.at(-1).complete({audioUrl: fixtureAudio});
      return result;
    };
  })()`);
  // Native HTMLMediaElement.play() requires a browser user activation.
  await page.send('Runtime.evaluate', {expression: 'els.listen.click()', userGesture: true});
  if (!autoRender) await page.evaluate('renders[0].complete({audioUrl: fixtureAudio})');
  await waitFor(page, "state.playing && !els.audio.paused && els.audio.currentTime > 0");
  return page;
}

for (const replacement of ['voice switch', 'paused fallback seek', 'paused browser keyboard seek', 'stop and restart']) {
  test(`replacement speech queue starts after ${replacement} despite cancel preserving paused state (review 6.1)`, async t => {
    const fallback = replacement === 'paused fallback seek';
    const page = await reader(t, {ready: !fallback});
    if (!page) return;
    await page.evaluate(`${fallback ? '' : "els.voiceSelect.value = 'browser'; els.voiceSelect.dispatchEvent(new Event('change'));"}
      els.listen.click(); els.listen.click(); window.previousUtterance = state.browserUtterance;`);
    assert.equal(await page.evaluate('speechSynthesis.paused'), true);
    await page.evaluate(({
      'voice switch': `els.voiceSelect.value = 'af_heart'; els.voiceSelect.dispatchEvent(new Event('change'));
        window.pausedAfterCancel = speechSynthesis.paused;
        els.voiceSelect.value = 'browser'; els.voiceSelect.dispatchEvent(new Event('change')); els.listen.click();`,
      'paused fallback seek': `els.bookText.children[2].click()`,
      'paused browser keyboard seek': `els.bookText.children[2].dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}))`,
      'stop and restart': `stopPlayback(); window.pausedAfterCancel = speechSynthesis.paused; els.listen.click();`
    })[replacement]);
    if (replacement === 'voice switch' || replacement === 'stop and restart') assert.equal(await page.evaluate('pausedAfterCancel'), true);
    assert.equal(await page.evaluate('speechSynthesis.paused'), false);
    assert.equal(await page.evaluate('state.playback'), 'playing');
    assert.equal(await page.evaluate('speechSynthesis.pending'), false);
    assert.equal(await page.evaluate('state.browserUtterance !== previousUtterance'), true);
    if (replacement.includes('seek')) assert.match(await page.evaluate('state.browserUtterance.text'), /^Paragraph 2\./);
    assert.match(await page.evaluate('els.listen.textContent'), /Pause listening/);
    // The replacement still has a working Pause/Resume transport.
    await page.evaluate('els.listen.click()');
    assert.equal(await page.evaluate('speechSynthesis.paused'), true);
    await page.evaluate('els.listen.click()');
    assert.equal(await page.evaluate('speechSynthesis.paused'), false);
    assert.deepEqual(page.errors, []);
  });
}

test('native source reload resets rate and emits ratechange, without any reader stubs', async t => {
  const page = await reader(t, {nativeAudio: true});
  if (!page) return;
  await page.evaluate(`(() => {
    window.probe = document.createElement('audio'); document.body.append(probe);
    window.probeEvents = []; probe.addEventListener('ratechange', () => probeEvents.push(probe.playbackRate));
    probe.src = ${JSON.stringify(wav())};
  })()`);
  await page.send('Runtime.evaluate', {expression: 'probe.play()', userGesture: true, awaitPromise: true});
  await page.evaluate('probe.playbackRate = 1.5');
  await waitFor(page, 'probeEvents.includes(1.5)');
  await page.evaluate('probe.pause(); probeEvents = []; probe.src = probe.src');
  await waitFor(page, 'probeEvents.includes(1)');
  assert.equal(await page.evaluate('probe.playbackRate'), 1);
  await page.evaluate('probe.removeAttribute("src"); probe.load(); probe.remove()');
});

test('native multi-chunk playback retains user speed and ignores automatic ratechange events (review 6.2)', async t => {
  const page = await nativeReader(t);
  if (!page) return;
  await page.evaluate('window.chunkCount = state.queue.length; window.oldPrefetch = renders[1]; els.audio.playbackRate = 1.5');
  await waitFor(page, 'oldPrefetch.aborted');
  // Let native WAV playback finish the chapter; never synthesize ended/ratechange.
  await waitFor(page, "state.playback === 'idle'", 20000);
  assert.equal(await page.evaluate('els.voiceState.textContent'), 'Chapter complete');
  const playing = await page.evaluate("mediaEvents.filter(event => event.type === 'playing')");
  assert.equal(playing.length, await page.evaluate('chunkCount'));
  assert(playing.length >= 3);
  assert(playing.slice(1).every(event => event.rate === 1.5), JSON.stringify(playing));
  assert.equal(await page.evaluate('els.audio.playbackRate'), 1.5, 'stop/load must retain the rate too');
  assert.equal(await page.evaluate('els.audio.defaultPlaybackRate'), 1.5);
  assert.equal(await page.evaluate('renders.length === chunkCount + 1'), true, 'only the user change invalidates speculation');
  assert.deepEqual(page.errors, []);
});

test('a speed change immediately followed by a native paragraph seek survives source loading', async t => {
  const page = await nativeReader(t);
  if (!page) return;
  await page.evaluate('window.oldPrefetch = renders[1]; els.audio.playbackRate = 1.75; els.bookText.children[2].click()');
  await waitFor(page, "mediaEvents.filter(event => event.type === 'playing').length >= 2 || state.playback === 'idle'");
  assert.equal(await page.evaluate('state.playback'), 'playing');
  assert.equal(await page.evaluate('els.audio.playbackRate'), 1.75);
  assert.equal(await page.evaluate('oldPrefetch.aborted'), true);
  assert.match(await page.evaluate('state.currentPassage'), /^Paragraph 2\./);
  assert.deepEqual(page.errors, []);
});

test('a genuine speed change during a pending native chunk still aborts it and permits restart at that speed', async t => {
  const page = await nativeReader(t, {autoRender: false});
  if (!page) return;
  await page.evaluate('ignoreAbort = true; els.audio.playbackRate = 1.5');
  await waitFor(page, "state.queueIndex === 1 && state.playback === 'pending'");
  await page.evaluate('window.pendingChunk = renders.at(-1); els.audio.playbackRate = 2');
  await waitFor(page, 'pendingChunk.aborted');
  await page.evaluate('pendingChunk.complete({audioUrl: fixtureAudio})');
  assert.equal(await page.evaluate('state.playback'), 'idle');
  assert.equal(await page.evaluate('els.audio.paused'), true);
  await page.send('Runtime.evaluate', {expression: 'els.listen.click()', userGesture: true});
  await page.evaluate('renders.at(-1).complete({audioUrl: fixtureAudio})');
  await waitFor(page, "state.playing || state.playback === 'idle'");
  assert.equal(await page.evaluate('state.playback'), 'playing');
  assert.equal(await page.evaluate('els.audio.playbackRate'), 2);
  assert.deepEqual(page.errors, []);
});
