const test = require('node:test');
const assert = require('node:assert/strict');
const { createReconciler, matchesPassage, pageIdentity } = require('../extension/passages');

function entry(text, scope = 'message:answer-a', node = {}) { return { text, scope, node }; }

test('unrelated streaming updates preserve the selected passage key and refresh its index', () => {
  const reconcile = createReconciler();
  const first = entry('Opening paragraph'), selected = entry('Selected paragraph'), tail = entry('Streaming tail');
  const before = reconcile([], [first, selected, tail]);
  const after = reconcile(before, [entry('New earlier paragraph'), selected, { ...tail, text: 'Streaming tail has grown' }, entry('New later paragraph')]);
  assert.equal(after[1].key, before[1].key);
  assert.equal(after[1].index, 1);
  assert.equal(after[2].key, before[2].key);
  assert.equal(matchesPassage(after[1], { text: 'Selected paragraph', blockOffset: 0 }), true);
});

test('a React redraw reattaches unchanged text to the same queue key', () => {
  const reconcile = createReconciler();
  const before = reconcile([], [entry('First paragraph'), entry('Read this paragraph')]);
  const after = reconcile(before, [entry('First paragraph'), entry('Read this paragraph')]);
  assert.deepEqual(after.map(item => item.key), before.map(item => item.key));
  assert.notEqual(after[1].node, before[1].node);
});

test('inserting repeated text cannot steal the identity of a surviving paragraph', () => {
  const reconcile = createReconciler(), selected = entry('Repeated sentence');
  const before = reconcile([], [selected]);
  const after = reconcile(before, [entry('Repeated sentence'), selected]);
  assert.equal(after[1].key, before[0].key);
  assert.notEqual(after[0].key, before[0].key);
});

test('identical text in different ChatGPT messages stays independent after redraws', () => {
  const reconcile = createReconciler();
  const before = reconcile([], [entry('Name', 'message:a'), entry('Name', 'message:b')]);
  const after = reconcile(before, [entry('Name', 'message:b'), entry('Name', 'message:a')]);
  assert.deepEqual(after.map(item => item.key), [before[1].key, before[0].key]);
});

test('a node reused for a different message does not retain the previous message key', () => {
  const reconcile = createReconciler(), node = {};
  const before = reconcile([], [entry('Read this', 'message:a', node)]);
  const after = reconcile(before, [entry('Read this', 'message:b', node)]);
  assert.notEqual(after[0].key, before[0].key);
});

test('virtualized conversation passages recover their keys after temporarily leaving the DOM', () => {
  const reconcile = createReconciler();
  const before = reconcile([], [entry('Name'), entry('Name'), entry('Later', 'message:b')]);
  const partial = reconcile(before, [entry('Later', 'message:b')]);
  const empty = reconcile(partial, []);
  const restored = reconcile(empty, [entry('Name'), entry('Name'), entry('Later', 'message:b')]);
  assert.deepEqual(restored.map(item => item.key), before.map(item => item.key));
});

test('later passage chunks require matching offsets and allow newly appended text', () => {
  const passage = { text: 'Read this part.', blockOffset: 9 };
  assert(matchesPassage({ text: 'Earlier. Read this part. A new tail.' }, passage));
  assert(!matchesPassage({ text: 'Earlier. Edited this part.' }, passage));
  assert(!matchesPassage({ text: 'Read this part.' }, passage));
  assert(!matchesPassage(null, passage));
  assert(!matchesPassage({ text: 'Read this part.' }, { text: 'Read', blockOffset: -1 }));
});

test('conversation navigation differs from ChatGPT model changes and heading anchors', () => {
  assert.equal(pageIdentity('https://chatgpt.com/c/one?model=fast#section'), pageIdentity('https://chatgpt.com/c/one?model=other'));
  assert.notEqual(pageIdentity('https://chatgpt.com/c/one'), pageIdentity('https://chatgpt.com/c/two'));
  assert.equal(pageIdentity('https://example.com/article#one'), pageIdentity('https://example.com/article#two'));
  assert.notEqual(pageIdentity('https://example.com/article?id=one'), pageIdentity('https://example.com/article?id=two'));
});
