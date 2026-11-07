const test = require('node:test');
const assert = require('node:assert/strict');
const { stretch } = require('../extension/tempo');
const { surfaceFor, passages, hitTest, mergePassages } = require('../extension/docs');
const { cleanText } = require('../public/text');
function group(lines) {
  const rects = lines.map(([text, x, y, width = 200, height = 20]) => ({
    getAttribute: () => text,
    getBoundingClientRect: () => ({ left: x, top: y, right: x + width, bottom: y + height, width, height })
  }));
  return { querySelectorAll: () => rects };
}
function docsFrame(groups) {
  return passages({ querySelectorAll: () => groups, getBoundingClientRect: () => ({ left: 0, top: 0 }) }, cleanText);
}

test('Docs reads the active document tab', (t) => {
  {
    const hidden = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
    const active = { getBoundingClientRect: () => ({ width: 800, height: 900 }) };
    assert.equal(surfaceFor({ querySelectorAll: () => [hidden, active] }), active);
    assert.equal(surfaceFor({ querySelectorAll: () => [hidden] }), null);
  }
});

test('Docs preserves paragraph/table identity across overlapping and recycled tiles', (t) => {
  {
    const first = group([
      ['First paragraph', 100, 100],
      ['continues here.', 100, 123]
    ]);
    const copy = group([
      ['First paragraph', 100, 100],
      ['continues here.', 100, 123]
    ]);
    const tableRight = group([['Name', 400, 200]]);
    const tableLeft = group([['Name', 100, 200]]);
    const later = group([
      ['First paragraph', 100, 300],
      ['continues here.', 100, 323]
    ]);
    const bullet = group([
      ['●', 76, 400, 12],
      ['A list entry', 100, 400]
    ]);
    const surface = {
      querySelectorAll: () => [first, copy, tableRight, tableLeft, later, bullet],
      getBoundingClientRect: () => ({ left: 0, top: 0 })
    };
    const entries = passages(surface, cleanText);
    assert.deepEqual(
      entries.map((entry) => entry.text),
      ['First paragraph continues here.', 'Name', 'Name', 'First paragraph continues here.', 'A list entry']
    );
    assert.equal(entries[0].nodes.length, 2);
    assert.equal(hitTest(entries, 450, 210), entries[2]);
    assert.equal(hitTest(entries, 110, 330), entries[3]);
    assert.equal(hitTest(entries, 110, 275), undefined);
  }
  {
    const start = mergePassages(
      [],
      docsFrame([
        group([
          ['First paragraph', 100, 100],
          ['continues here.', 100, 123]
        ]),
        group([['Name', 100, 200]]),
        group([['Name', 400, 200]])
      ]),
      cleanText
    );
    const next = mergePassages(
      start,
      docsFrame([
        group([['Name', 100, 200]]),
        group([['Name', 400, 200]]),
        group([['A newly rendered page.', 100, 1200]])
      ]),
      cleanText
    );
    assert.deepEqual(
      next.map((entry) => entry.text),
      ['First paragraph continues here.', 'Name', 'Name', 'A newly rendered page.']
    );
    assert.deepEqual(
      next.slice(0, 3).map((entry) => entry.key),
      start.map((entry) => entry.key)
    );
    assert.equal(next[0].node, null);
    assert.equal(next[0].rects.length, 0);
    assert.equal(hitTest(next, 110, 110), undefined);
    assert.equal(hitTest(next, 450, 210), next[2]);
    const empty = mergePassages(next, [], cleanText);
    assert.deepEqual(
      empty.map((entry) => entry.text),
      next.map((entry) => entry.text)
    );
    assert(empty.every((entry) => entry.rects.length === 0 && entry.nodes.length === 0));
    const restored = mergePassages(
      empty,
      docsFrame([
        group([
          ['First paragraph', 100, 100],
          ['continues here.', 100, 123]
        ])
      ]),
      cleanText
    );
    assert.equal(restored.length, 4);
    assert.equal(restored[0].key, start[0].key);
    assert.equal(hitTest(restored, 110, 130), restored[0]);
  }
  {
    const start = mergePassages(
      [],
      docsFrame([
        group([
          ['Beginning', 100, 100],
          ['Middle', 100, 123],
          ['End', 100, 146]
        ])
      ]),
      cleanText
    );
    const partial = mergePassages(
      start,
      docsFrame([
        group([
          ['Middle', 100, 123],
          ['End', 100, 146]
        ]),
        group([['Earlier heading', 100, 50]])
      ]),
      cleanText
    );
    assert.equal(partial[1].text, 'Beginning Middle End');
    assert.equal(partial[1].key, start[0].key);
    assert.equal(partial[1].index, 1);
    const restored = mergePassages(
      partial,
      docsFrame([
        group([
          ['Beginning', 100, 100],
          ['Middle', 100, 123],
          ['End', 100, 146]
        ])
      ]),
      cleanText
    );
    assert.equal(restored[1].text, 'Beginning Middle End');
    assert.equal(restored.length, 2);
  }
  {
    const start = mergePassages(
      [],
      docsFrame([
        group([
          ['An original paragraph', 100, 100],
          ['with two lines.', 100, 123]
        ])
      ]),
      cleanText
    );
    const edited = mergePassages(start, docsFrame([group([['A revised paragraph.', 100, 100]])]), cleanText);
    assert.equal(edited.length, 1);
    assert.equal(edited[0].text, 'A revised paragraph.');
    assert.equal(edited[0].key, start[0].key);
    assert.equal(start[0].text, 'An original paragraph with two lines.');
  }
});
