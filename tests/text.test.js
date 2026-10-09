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
