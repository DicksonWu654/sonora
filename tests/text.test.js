const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chunksFor, cleanText } = require('../public/text');
const compact = text => text.replace(/\s+/g, ' ').trim();

test('a whole book stays within the voice limit without losing words', () => {
  const book = fs.readFileSync(path.join(__dirname, '../public/moby-dick.txt'), 'utf8');
  const chunks = chunksFor(book);
  assert(chunks.length > 500);
  assert(chunks.every(chunk => chunk.length <= 1200));
  assert.equal(compact(chunks.join(' ')), compact(cleanText(book)));
});
test('oversized paragraphs and sentences obey a hard limit', () => {
  const book = 'An unusually long sentence with no stop '.repeat(1000);
  const chunks = chunksFor(book, 400);
  assert(chunks.every(chunk => chunk.length <= 400));
  assert.equal(compact(chunks.join(' ')), compact(book));
});
test('long words and Unicode cannot break the passage boundary', () => {
  const book = 'x'.repeat(4100) + '😀'.repeat(1500);
  const chunks = chunksFor(book, 101);
  assert(chunks.every(chunk => chunk.length <= 101 && chunk.isWellFormed()));
  assert.equal(chunks.join(''), book);
});
test('import artifacts are removed while dialogue and short paragraphs survive', () => {
  const book = '\ufeff“Hello,” she said.\u0000\u000b\n\nNo.\n\nA soft\u00adhyphen and a zero\u200bwidth space.';
  const normalized = cleanText(book);
  assert(normalized.includes('No.'));
  assert(normalized.includes('“Hello,”'));
  assert(!/[\u0000\u000b\ufeff\u00ad\u200b]/.test(normalized));
  assert.equal(compact(chunksFor(book, 40).join(' ')), compact(normalized));
});
test('invalid limits fail instead of looping forever', () => {
  assert.throws(() => chunksFor('Hello', 0));
});

test('interactive openings prefer the first sentence, cap long sentences, and keep every word at the seam', () => {
  const { openingChunksFor } = require('../public/text');
  const fixtures = [
    'A short first sentence. ' + 'The normal remainder continues here. '.repeat(90),
    Array.from({ length: 65 }, (_, at) => `word${at}`).join(' ') + '. Next sentence.',
    Array.from({ length: 65 }, (_, at) => `word${at}`).join(' '),
    'A repeated phrase. A repeated phrase. A repeated phrase.',
    'First line without punctuation\nNext line with combining cafe\u0301 and 😀 emoji',
    'x'.repeat(4000) + '😀'.repeat(1200)
  ];
  for (const text of fixtures) {
    const normalized = cleanText(text), pieces = openingChunksFor(text);
    assert(pieces[0].split(/\s+/).length <= 25);
    assert(pieces.every(piece => piece.length <= 1200 && piece.isWellFormed()));
    assert.equal(pieces.join('').replace(/\s/g, ''), normalized.replace(/\s/g, ''));
    let offset = 0;
    for (const piece of pieces) {
      const at = normalized.indexOf(piece, offset);
      assert(at >= offset);
      assert.equal(normalized.slice(offset, at).trim(), '');
      offset = at + piece.length;
    }
    assert.equal(normalized.slice(offset).trim(), '');
  }
  assert.equal(openingChunksFor(fixtures[0])[0], 'A short first sentence.');
  assert.equal(openingChunksFor(fixtures[1])[0].split(/\s+/).length, 25);
  assert.equal(openingChunksFor(fixtures[2])[0].split(/\s+/).length, 20);
  assert.deepEqual(openingChunksFor(''), []);
  assert.throws(() => openingChunksFor('Text', 0), /Invalid passage limit/);
});

test('a short opening inside a long code line preserves code passage offsets and following lines', () => {
  const { openingChunksFor } = require('../public/text');
  const { codePassages } = require('../extension/passages');
  const { chunkOffsets } = require('../extension/words');
  const text = cleanText('{\nconst values = [' + Array.from({ length: 90 }, (_, at) => `value${at},`).join(' ') + '];\nreturn values;\n}\nreturn values;');
  const parts = codePassages(text, chunksFor);
  const first = parts.shift(), opening = openingChunksFor(first.text);
  const offsets = chunkOffsets(first.text, opening);
  const queue = [...opening.map((text, at) => ({ text, offset: first.offset + offsets[at] })), ...parts];
  assert(queue[0].text.split(/\s+/).length <= 25);
  assert.equal(queue.map(part => part.text).join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  for (const part of queue) assert.equal(text.slice(part.offset, part.offset + part.text.length), part.text);
  assert.equal(queue.at(-1).text, 'return values;');
});
