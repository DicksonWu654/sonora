const test = require('node:test');
const assert = require('node:assert/strict');
test('audit2 #12 spoken URLs are bounded and timing offsets still select the original words', () => {
  const speech = require('../extension/speech');
  const raw = 'Visit https://example.com/path?tracking=' + 'x'.repeat(1300) + ' then continue.';
  const prepared = speech.prepare(raw);
  assert(prepared.text.length < 100);
  assert(!prepared.text.includes('tracking'));
  const at = prepared.text.indexOf('continue');
  const mapped = speech.mapWords(prepared, [{ textOffset: at, length: 8, start: 0, end: 1 }])[0];
  assert.equal(raw.slice(mapped.textOffset, mapped.textOffset + mapped.length), 'continue');
  const part = speech.completePart(raw, { offset: 0, text: raw.slice(0, 1200) });
  assert(part.text.endsWith('x'));
  assert.equal(raw.slice(part.offset + part.text.length), ' then continue.');
});
test('audit2 #18 unsupported scripts get an English cue rather than character names', () => {
  const speech = require('../extension/speech');
  for (const source of ['هذا نص عربي', 'שלום עולם', '猫', 'Русский текст', '日本語']) {
    const prepared = speech.prepare(source);
    assert.match(prepared.text, /unsupported language/i);
    assert(!/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Han}\p{Script=Cyrillic}]/u.test(prepared.text));
  }
  assert.equal(speech.prepare('Read café and naïve prose.').text, 'Read café and naïve prose.');
});

test('audit2 #18 playback sends an unsupported-language cue and continues through surrounding prose', async (t) => {
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
