const test = require('node:test');
const assert = require('node:assert/strict');
const { createReconciler, matchesPassage, pageIdentity, codePassages } = require('../extension/passages');
const { chunksFor, cleanText } = require('../public/text');
function entry(text, scope = 'message:answer-a', node = {}) {
  return { text, scope, node };
}

test('passage selection survives insertion, duplicate text, redraw and virtualization', (t) => {
  {
    const reconcile = createReconciler();
    const first = entry('Opening paragraph'),
      selected = entry('Selected paragraph'),
      tail = entry('Streaming tail');
    const before = reconcile([], [first, selected, tail]);
    const after = reconcile(before, [
      entry('New earlier paragraph'),
      selected,
      { ...tail, text: 'Streaming tail has grown' },
      entry('New later paragraph')
    ]);
    assert.equal(after[1].key, before[1].key);
    assert.equal(after[1].index, 1);
    assert.equal(after[2].key, before[2].key);
    assert.equal(matchesPassage(after[1], { text: 'Selected paragraph', blockOffset: 0 }), true);
  }
  {
    const reconcile = createReconciler();
    const before = reconcile([], [entry('Name', 'message:a'), entry('Name', 'message:b')]);
    const after = reconcile(before, [entry('Name', 'message:b'), entry('Name', 'message:a')]);
    assert.deepEqual(
      after.map((item) => item.key),
      [before[1].key, before[0].key]
    );
  }
  {
    const reconcile = createReconciler();
    const before = reconcile([], [entry('Name'), entry('Name'), entry('Later', 'message:b')]);
    const partial = reconcile(before, [entry('Later', 'message:b')]);
    const empty = reconcile(partial, []);
    const restored = reconcile(empty, [entry('Name'), entry('Name'), entry('Later', 'message:b')]);
    assert.deepEqual(
      restored.map((item) => item.key),
      before.map((item) => item.key)
    );
  }
});

test('append-only updates retain the passage while navigation and edits invalidate it', (t) => {
  {
    const passage = { text: 'Read this part.', blockOffset: 9 };
    assert(matchesPassage({ text: 'Earlier. Read this part. A new tail.' }, passage));
    assert(!matchesPassage({ text: 'Earlier. Edited this part.' }, passage));
    assert(!matchesPassage({ text: 'Read this part.' }, passage));
    assert(!matchesPassage(null, passage));
    assert(!matchesPassage({ text: 'Read this part.' }, { text: 'Read', blockOffset: -1 }));
  }
  {
    assert.equal(
      pageIdentity('https://chatgpt.com/c/one?model=fast#section'),
      pageIdentity('https://chatgpt.com/c/one?model=other')
    );
    assert.notEqual(pageIdentity('https://chatgpt.com/c/one'), pageIdentity('https://chatgpt.com/c/two'));
    assert.equal(pageIdentity('https://example.com/article#one'), pageIdentity('https://example.com/article#two'));
    assert.notEqual(
      pageIdentity('https://example.com/article?id=one'),
      pageIdentity('https://example.com/article?id=two')
    );
  }
});

test('code chunks preserve line order, Unicode and source offsets', (t) => {
  {
    const text = cleanText('run init\n\nrun test --fast \\\n  --target "Example" \\\n  --limit 100\nrun init');
    const parts = codePassages(text, chunksFor);
    assert.deepEqual(
      parts.map((part) => part.text),
      ['run init', 'run test --fast \\', '--target "Example" \\', '--limit 100', 'run init']
    );
    assert.notEqual(parts[0].offset, parts.at(-1).offset);
    for (const part of parts) assert.equal(text.slice(part.offset, part.offset + part.text.length), part.text);
  }
  {
    const text = '{\ncall();\n}\n\nnext();\n---';
    assert.deepEqual(codePassages(text, chunksFor), [
      { text: '{\ncall();\n}', offset: 0 },
      { text: 'next();\n---', offset: 13 }
    ]);
    assert.deepEqual(codePassages('{\n}\n---', chunksFor), []);
  }
  {
    const text = cleanText('const value = "' + 'x😀'.repeat(900) + '";\nreturn value;\n}');
    const parts = codePassages(text, chunksFor, 100);
    assert(parts.length > 20);
    assert(parts.every((part) => part.text.length <= 100 && part.text.isWellFormed()));
    for (const part of parts) assert.equal(text.slice(part.offset, part.offset + part.text.length), part.text);
    assert.equal(
      parts
        .map((part) => part.text)
        .join('')
        .replace(/\s/g, ''),
      text.replace(/\s/g, '')
    );
  }
});
