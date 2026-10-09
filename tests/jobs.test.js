const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBookJobs } = require('../tools/books/jobs');
const { rss, serveFile } = require('../tools/books/http');
const http = require('node:http');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function terminal(jobs, id) {
  for (let i = 0; i < 300; i++) {
    const job = jobs.get(id);
    if (['complete', 'failed'].includes(job.state)) return job;
    await pause(10);
  }
  throw new Error('Timed out waiting for test conversion.');
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const encoder = path.join(root, 'encoder');
  fs.writeFileSync(encoder, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv.at(-1), Buffer.alloc(4096));\n', { mode: 0o700 });
  const cacheDirectory = path.join(root, 'cache'); fs.mkdirSync(cacheDirectory);
  let renders = 0;
  const cache = new Set();
  let fail = false, rejectLarge = false;
  const narration = {
    status: () => ({ ready: true, installed: true }),
    generate: async text => {
      if (fail && text.includes('FAILHERE')) throw Object.assign(new Error('Injected model failure'), { status: 422 });
      if (rejectLarge && text.length > 170) throw Object.assign(new Error('Injected passage overflow'), { status: 422 });
      const key = crypto.createHash('sha256').update(text).digest('hex');
      if (!cache.has(key)) { renders++; cache.add(key); fs.writeFileSync(path.join(cacheDirectory, key + '.wav'), 'fixture'); }
      return { audioUrl: `/api/narration/audio/${key}.wav`, duration: 1 };
    }
  };
  return { options: { directory: path.join(root, 'books'), cacheDirectory, ffmpeg: encoder, narration },
    renders: () => renders, fail: value => { fail = value; }, rejectLarge: value => { rejectLarge = value; } };
}
test('a failed book resumes from its saved cache after a server restart', async t => {
  const f = fixture(t); f.fail(true);
  let jobs = createBookJobs(f.options);
  const text = 'A safe passage. '.repeat(75) + '\n\n' + 'FAILHERE another passage. '.repeat(80);
  const original = jobs.create({ text, title: 'Resume test' });
  const failed = await terminal(jobs, original.id);
  assert.equal(failed.state, 'failed'); assert(failed.completed > 0);
  const alreadyRendered = f.renders();
  jobs.close(); f.fail(false);
  jobs = createBookJobs(f.options); t.after(() => jobs.close());
  assert.equal(jobs.get(original.id).completed, failed.completed);
  jobs.retry(original.id);
  const done = await terminal(jobs, original.id);
  assert.equal(done.state, 'complete'); assert.equal(done.completed, done.total);
  assert(f.renders() > alreadyRendered);
  assert(f.renders() <= alreadyRendered + done.total - failed.completed);
  assert.equal(jobs.create({ text, title: 'Resume test' }).id, done.id);
  assert(!JSON.stringify(jobs.list()).includes('FAILHERE'));
});
test('model overflow triggers smaller passages and publishes only complete audio', async t => {
  const f = fixture(t); f.rejectLarge(true);
  const jobs = createBookJobs(f.options); t.after(() => jobs.close());
  const job = jobs.create({ text: 'A passage that expands during pronunciation. '.repeat(30), title: 'A & B' });
  assert(!rss(jobs.list(), 'https://example.com', 'private').includes('<item>'));
  const done = await terminal(jobs, job.id);
  assert.equal(done.state, 'complete'); assert(done.duration > done.total);
  const feed = rss(jobs.list(), 'https://example.com', 'private');
  assert(feed.includes('<title>A &amp; B</title>')); assert(feed.includes('type="audio/mpeg"')); assert(feed.includes('length="4096"'));
});
test('podcast byte ranges support seeking, suffixes, HEAD and invalid ranges', async t => {
  const f = fixture(t);
  const file = path.join(f.options.cacheDirectory, 'range.mp3'); fs.writeFileSync(file, '0123456789');
  const server = http.createServer((req, res) => serveFile(req, res, file, 'audio/mpeg'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206); assert.equal(await suffix.text(), '789');
  const range = await fetch(url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(await range.text(), '234'); assert.equal(range.headers.get('content-range'), 'bytes 2-4/10');
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  for (const value of ['bytes=-0', 'bytes=20-', 'bytes=5-2', 'bytes=0-1,3-4']) assert.equal((await fetch(url, { headers: { Range: value } })).status, 416);
});
