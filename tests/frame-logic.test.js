const test = require('node:test');
const assert = require('node:assert/strict');
const frames = require('../extension/frames');
test('loaded frame association does not assume browser inventory order matches DOM order', async () => {
  const top = {
    path: [],
    readable: false,
    sample: 'empty',
    score: 0,
    documents: [
      { path: [0], sourceUrl: 'https://static.test/doc' },
      { path: [1], sourceUrl: 'https://old.embed.test/doc' }
    ],
    frames: [{ path: [1], area: 500000 }]
  };
  const loaded = [
    { frameId: 7, parentFrameId: 0, url: 'https://new.embed.test/doc' },
    { frameId: 8, parentFrameId: 0, url: 'https://static.test/doc' }
  ];
  const candidate = frames.candidates(top, [], loaded)[0];
  assert.equal(candidate.frameId, 7);
  assert.equal(frames.originPattern(candidate.url), 'https://new.embed.test/*');
});

test('nested frame areas include the exposed part of every ancestor', () => {
  const outer = {
    path: [0],
    area: 500000,
    clip: { left: 0, top: 0, right: 500, bottom: 1000 },
    content: { left: 0, top: 0, width: 1000, height: 1000 },
    scaleX: 1,
    scaleY: 1
  };
  const hidden = { path: [0, 0], area: 400000, clip: { left: 600, top: 0, right: 1000, bottom: 1000 } };
  const shown = { path: [0, 1], area: 400000, clip: { left: 200, top: 0, right: 600, bottom: 1000 } };
  const top = { frames: [outer] };
  const results = [
    { frameId: 7, result: { path: [0], score: 0, frames: [hidden, shown] } },
    { frameId: 8, result: { path: [0, 0], readable: true, score: 500, frames: [] } },
    { frameId: 9, result: { path: [0, 1], readable: true, score: 500, frames: [] } }
  ];
  const ranked = frames.candidates(top, results);
  assert.equal(
    ranked.some((frame) => frame.frameId === 8),
    false
  );
  assert.equal(ranked.find((frame) => frame.frameId === 9).area, 300000);
});

test('Claude artifact grants cover that service while other sites keep exact origins', () => {
  assert.equal(
    frames.originPattern('https://one.frame.claudeusercontent.com/doc'),
    'https://*.frame.claudeusercontent.com/*'
  );
  assert.equal(
    frames.originPattern('https://two.frame.claudeusercontent.com/doc'),
    'https://*.frame.claudeusercontent.com/*'
  );
  assert.equal(
    frames.originPattern('https://claudeusercontent.com.attacker.test/doc'),
    'https://claudeusercontent.com.attacker.test/*'
  );
  assert.equal(frames.originPattern('https://docs.test/article'), 'https://docs.test/*');
});
