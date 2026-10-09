const test = require('node:test');
const assert = require('node:assert/strict');
const { compactMap, compactSpan, chunkOffsets, wordAt, domRange, docsRects, createTracker } = require('../extension/words');

test('word offsets map normalized ligatures, combining accents and emoji back to original UTF-16', () => {
  const map = compactMap('  oﬃce\u200b cafe\u0301 😀  ');
  assert.equal(map.text, 'officecafé😀');
  const span = compactSpan(map, 3, 1);
  assert.equal(map.text.slice(span.start, span.end), 'ffi');
  assert.deepEqual(map.positions.slice(span.start, span.end), Array(3).fill({ start: 3, end: 4 }));
  const accent = compactSpan(map, 11, 2);
  assert.equal(map.text.slice(accent.start, accent.end), 'é');
  const emoji = compactSpan(map, 14, 2);
  assert.equal(map.text.slice(emoji.start, emoji.end), '😀');
  assert.equal(compactSpan(map, 0, 2), null);
  assert.equal(compactSpan(map, -1, 2), null);
});

test('timing lookup follows model boundaries and clears during silence and after completion', () => {
  const words = [{ start: 0.2, end: 0.5 }, { start: 0.7, end: 1.1 }, { start: 1.1, end: 1.5 }];
  for (const [time, expected] of [[0, -1], [0.2, 0], [0.49, 0], [0.5, -1], [0.6, -1], [0.7, 1], [1.1, 2], [1.5, -1], [3, -1]]) {
    assert.equal(wordAt(words, time), expected, `at ${time}s`);
  }
  assert.equal(wordAt([], 0), -1);
});

test('repeated chunks keep their distinct offsets within the original passage', () => {
  assert.deepEqual(chunkOffsets('Same sentence.\n\nSame sentence. Tail.', ['Same sentence.', 'Same sentence.', 'Tail.']), [0, 16, 31]);
  assert.deepEqual(chunkOffsets('A sentence.', ['Missing']), [-1]);
});

test('a DOM word range spans inline nodes and fails safely when the page detaches them', () => {
  const first = { isConnected: true }, last = { isConnected: true };
  const index = { ...compactMap('Reading'), segments: [{ node: first, start: 0, end: 4 }, { node: last, start: 4, end: 7 }] };
  const points = [];
  const document = { createRange: () => ({ setStart: (...args) => points.push(args), setEnd: (...args) => points.push(args) }) };
  assert(domRange(index, { start: 0, end: 7 }, document));
  assert.deepEqual(points, [[first, 0], [last, 3]]);
  last.isConnected = false;
  assert.equal(domRange(index, { start: 0, end: 7 }, document), null);
});

const context = { font: '', measureText: text => ({ width: text.length * 10 }) };
const surface = { getBoundingClientRect: () => ({ left: 20, top: 30 }), closest: () => null };
function docsEntry(texts = ['Read this', 'next word']) {
  const lines = texts.map((text, i) => ({ text, x: 100, y: 100 + 25 * i, width: text.length * 10, height: 20 }));
  const rects = lines.map(line => ({
    isConnected: true,
    getAttribute: name => name === 'aria-label' ? line.text : '400 16px Roboto',
    getBoundingClientRect: () => ({ left: line.x + 20, top: line.y + 30, width: line.width, height: 20 })
  }));
  return { text: texts.join(' '), lines, rects };
}

test('Docs maps word positions to the right line, cell and font without highlighting the whole paragraph', () => {
  const entry = docsEntry();
  assert.deepEqual(docsRects(entry, { start: 4, end: 8 }, surface, context), [{ left: 170, top: 130, width: 40, height: 20 }]);
  assert.equal(context.font, '400 16px Roboto');
  assert.deepEqual(docsRects(entry, { start: 8, end: 12 }, surface, context), [{ left: 120, top: 155, width: 40, height: 20 }]);
  entry.rects[1].isConnected = false;
  assert.deepEqual(docsRects(entry, { start: 8, end: 12 }, surface, context), []);
  entry.rects[1].isConnected = true;
  entry.rects[1].getBoundingClientRect = () => ({ left: 400, top: 155, width: 90, height: 20 });
  assert.deepEqual(docsRects(entry, { start: 8, end: 12 }, surface, context), []);
});

function trackerFixture() {
  const children = [];
  const document = {
    defaultView: { innerWidth: 1000, innerHeight: 900 },
    createElement: tag => tag === 'canvas' ? { getContext: () => context } : {
      style: {}, dataset: {}, setAttribute() {}, remove() { children.splice(children.indexOf(this), 1); }
    }
  };
  return { tracker: createTracker(document, { append: box => children.push(box) }), children };
}

test('word tracker follows successive words, clears silence, and removes every mark on reset', () => {
  const { tracker, children } = trackerFixture(), entry = docsEntry();
  tracker.prepare(entry, { text: entry.text, blockOffset: 0 }, [{ start: 0.1, end: 0.5, textOffset: 0, length: 4 }, { start: 0.7, end: 1, textOffset: 5, length: 4 }]);
  tracker.update(entry, 0.2, surface);
  assert.equal(children[0].dataset.word, 'Read');
  assert.equal(children[0].style.width, '40px');
  tracker.update(entry, 0.6, surface);
  assert.equal(children.length, 0);
  tracker.update(entry, 0.8, surface);
  assert.equal(children[0].dataset.word, 'this');
  tracker.reset();
  assert.equal(children.length, 0);
  tracker.update(entry, 0.8, surface);
  assert.equal(children.length, 0);
});

test('later narration chunks highlight their own copy of repeated words', () => {
  const { tracker, children } = trackerFixture(), entry = docsEntry(['Read Read']);
  tracker.prepare(entry, { text: 'Read', blockOffset: 5 }, [{ start: 0, end: 1, textOffset: 0, length: 4 }]);
  tracker.update(entry, 0.4, surface);
  assert.equal(children[0].style.left, '170px');
});

test('edited source, mismatched chunks, missing or invalid timings never produce a guessed highlight', () => {
  const { tracker, children } = trackerFixture(), entry = docsEntry();
  const timing = { start: 0, end: 1, textOffset: 0, length: 4 };
  tracker.prepare(entry, { text: entry.text, blockOffset: 0 }, [timing]);
  tracker.update({ ...entry, text: 'Edited source' }, 0.2, surface);
  assert.equal(children.length, 0);
  for (const [passage, timings] of [
    [{ text: 'Different words', blockOffset: 0 }, [timing]],
    [{ text: entry.text, blockOffset: 0 }, undefined],
    [{ text: entry.text, blockOffset: 0 }, [null, { ...timing, length: 999 }, { ...timing, end: -1 }]]
  ]) {
    tracker.prepare(entry, passage, timings);
    tracker.update(entry, 0.2, surface);
    assert.equal(children.length, 0);
  }
});

test('appending to a streaming passage keeps timings for its unchanged spoken prefix', () => {
  const { tracker, children } = trackerFixture(), entry = docsEntry();
  tracker.prepare(entry, { text: entry.text, blockOffset: 0 }, [{ start: 0, end: 1, textOffset: 0, length: 4 }]);
  tracker.update({ ...entry, text: entry.text + ' More text arrived.' }, 0.5, surface);
  assert.equal(children[0].dataset.word, 'Read');
});

function domTrackerFixture() {
  const highlights = new Map();
  const document = {
    defaultView: { CSS: { highlights }, Highlight: class extends Set { constructor(...ranges) { super(ranges); } }, getComputedStyle: () => ({ visibility: 'visible' }) },
    createElement: () => ({ getContext: () => context }),
    createTreeWalker: node => {
      let next = 0;
      return { nextNode() { this.currentNode = node.textNodes[next++]; return Boolean(this.currentNode); } };
    },
    createRange: () => ({
      selectNodeContents() {}, getClientRects: () => [{ width: 100, height: 20 }],
      setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
      setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    })
  };
  const makeNode = text => {
    const node = { isConnected: true, matches: () => false };
    node.textNodes = [{ data: text, isConnected: true, parentElement: { closest: () => null } }];
    return node;
  };
  return { tracker: createTracker(document, {}), highlights, makeNode };
}

test('word highlight reattaches after React replaces text nodes during the same spoken word', () => {
  const { tracker, highlights, makeNode } = domTrackerFixture();
  const original = makeNode('Read this'), replacement = makeNode('Read this');
  const passage = { text: 'Read this', blockOffset: 0 };
  tracker.prepare({ node: original, text: passage.text }, passage, [{ start: 0, end: 1, textOffset: 5, length: 4 }]);
  tracker.update({ node: original, text: passage.text }, 0.2, null);
  original.isConnected = original.textNodes[0].isConnected = false;
  tracker.update({ node: replacement, text: passage.text }, 0.3, null);
  const range = [...highlights.get('sonora-current-word')][0];
  assert.equal(range.startContainer, replacement.textNodes[0]);
  assert.equal(range.startOffset, 5);
  assert.equal(range.endOffset, 9);
});

test('normalization-equivalent live text edits refresh DOM offsets without interrupting a word', () => {
  const { tracker, highlights, makeNode } = domTrackerFixture();
  const node = makeNode('Read this'), passage = { text: 'Read this', blockOffset: 0 };
  tracker.prepare({ node, text: passage.text }, passage, [{ start: 0, end: 1, textOffset: 5, length: 4 }]);
  tracker.update({ node, text: passage.text }, 0.2, null);
  node.textNodes[0].data = 'Read  this';
  tracker.update({ node, text: passage.text }, 0.3, null);
  const range = [...highlights.get('sonora-current-word')][0];
  assert.equal(range.startOffset, 6);
  assert.equal(range.endOffset, 10);
});
