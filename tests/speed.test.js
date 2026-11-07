const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpeed, formatSpeed } = require('../extension/speed');
const { stretch } = require('../extension/tempo');

test('speed values clamp to the slider and round to exact tenths', () => {
  assert.equal(normalizeSpeed(0.75), 1);
  assert.equal(normalizeSpeed(1.04), 1);
  assert.equal(normalizeSpeed(1.05), 1.1);
  assert.equal(normalizeSpeed(1.15), 1.2);
  for (const [old, migrated] of [
    [0.75, 1],
    [1.25, 1.3],
    [2.25, 2.3],
    [2.75, 2.8],
    ['1.5', 1.5]
  ])
    assert.equal(normalizeSpeed(old), migrated);
  assert.equal(normalizeSpeed(1.7000000002), 1.7);
  assert.equal(normalizeSpeed(4), 3);
  assert.equal(formatSpeed(1.7), '1.7×');
  assert.equal(formatSpeed(2), '2×');
});

test('tempo accepts every arbitrary tenth speed in the slider range', () => {
  const input = Float32Array.from({ length: 48000 }, (_, at) => Math.sin((2 * Math.PI * 220 * at) / 24000));
  for (let tenths = 10; tenths <= 30; tenths++) {
    const rate = tenths / 10;
    const output = stretch([input], 24000, rate)[0];
    assert.equal(output.length, Math.round(input.length / rate), `${rate}x`);
    let crossings = 0;
    const start = Math.floor(output.length * 0.1),
      end = Math.floor(output.length * 0.9);
    for (let at = start + 1; at < end; at++) if (output[at - 1] <= 0 && output[at] > 0) crossings++;
    assert(Math.abs((crossings * 24000) / (end - start) - 220) < 3, `${rate}x changed pitch`);
    assert(output.every(Number.isFinite));
  }
});
