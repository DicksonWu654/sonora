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
  const wav = Buffer.alloc(48044);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(48000, 40);
  let fail = false, rejectLarge = false;
  const narration = {
    status: () => ({ ready: true, installed: true }),
    generate: async text => {
      if (fail && text.includes('FAILHERE')) throw Object.assign(new Error('Injected model failure'), { status: 422 });
      if (rejectLarge && text.length > 170) throw Object.assign(new Error('Injected passage overflow'), { status: 422 });
      const key = crypto.createHash('sha256').update(text).digest('hex');
      if (!cache.has(key) || !fs.existsSync(path.join(cacheDirectory, key + '.wav'))) { renders++; cache.add(key); fs.writeFileSync(path.join(cacheDirectory, key + '.wav'), wav); }
      return { audioUrl: `/api/narration/audio/${key}.wav`, duration: 1 };
    }
  };
  return { options: { directory: path.join(root, 'books'), cacheDirectory, ffmpeg: encoder, narration },
    renders: () => renders, fail: value => { fail = value; }, rejectLarge: value => { rejectLarge = value; },
    evict() { for (const name of fs.readdirSync(cacheDirectory)) if (name.endsWith('.wav')) fs.unlinkSync(path.join(cacheDirectory, name)); } };
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

test('book assembly survives render-cache eviction and removes disposable parts', async t => {
  const f = fixture(t), generate = f.options.narration.generate;
  f.options.narration.generate = async (...args) => { f.evict(); return generate(...args); };
  fs.writeFileSync(f.options.ffmpeg, `#!/usr/bin/env node
const fs=require('node:fs');const list=fs.readFileSync(process.argv[process.argv.indexOf('-i')+1],'utf8');
for(const line of list.split('\\n'))if(!fs.existsSync(line.slice(6,-1)))throw Error('A book part was evicted');
fs.writeFileSync(process.argv.at(-1),Buffer.alloc(4096));
`, {mode: 0o700});
  const jobs = createBookJobs(f.options); t.after(() => jobs.close());
  const job = jobs.create({text: 'Read this complete book. '.repeat(180), title: 'Eviction during a book'});
  const done = await terminal(jobs, job.id);
  assert.equal(done.state, 'complete', done.error);
  const folder = path.dirname(jobs.audioFile(job.id));
  assert(!fs.existsSync(path.join(folder, 'parts')));
  assert(!fs.existsSync(path.join(folder, 'concat.txt')));
  assert(!fs.existsSync(path.join(folder, 'book.tmp.mp3')));
});

test('a saved book resumes without re-rendering healthy staged parts after cache eviction', async t => {
  const f = fixture(t); f.fail(true);
  let jobs = createBookJobs(f.options);
  const job = jobs.create({text: 'Healthy opening. '.repeat(75) + '\n\n' + 'FAILHERE another passage. '.repeat(80)});
  const failed = await terminal(jobs, job.id);
  assert.equal(failed.state, 'failed'); assert(failed.completed > 0);
  const before = f.renders();
  jobs.close(); f.evict(); f.fail(false);
  jobs = createBookJobs(f.options); t.after(() => jobs.close());
  jobs.retry(job.id);
  const done = await terminal(jobs, job.id);
  assert.equal(done.state, 'complete', done.error);
  assert.equal(f.renders() - before, done.total - failed.completed);
});

test('book storage quotas stop new output while preserving completed books', async t => {
  const f = fixture(t);
  let jobs = createBookJobs(f.options);
  const job = jobs.create({text: 'A saved book.', title: 'Keep me'});
  assert.equal((await terminal(jobs, job.id)).state, 'complete');
  const file = jobs.audioFile(job.id); fs.writeFileSync(file, Buffer.alloc(50000, 1));
  jobs.close(); jobs = createBookJobs({...f.options, maxBytes: 80000}); t.after(() => jobs.close());
  assert.throws(() => jobs.create({text: 'Another book.'}), error => error.status === 507 && /SONORA_BOOKS_MB/.test(error.message));
  assert.equal(jobs.list().length, 1);
  assert.equal(fs.statSync(file).size, 50000);
});

test('book quota failures retain checkpoints and remove truncated encodes', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.options.ffmpeg, `#!/usr/bin/env node
const fs=require('node:fs');const limit=Number(process.argv[process.argv.indexOf('-fs')+1]);
fs.writeFileSync(process.argv.at(-1),Buffer.alloc(limit));
`, {mode: 0o700});
  const jobs = createBookJobs({...f.options, maxBytes: 300000}); t.after(() => jobs.close());
  const job = jobs.create({text: 'This encode reaches the storage limit.'});
  const done = await terminal(jobs, job.id);
  assert.equal(done.state, 'failed'); assert.match(done.error, /SONORA_BOOKS_MB/);
  const folder = path.dirname(jobs.audioFile(job.id));
  assert(fs.existsSync(path.join(folder, 'job.json')));
  for (const name of ['book.mp3', 'book.tmp.mp3', 'concat.txt']) assert(!fs.existsSync(path.join(folder, name)));
  assert(fs.existsSync(path.join(folder, 'parts')));
  const {sizeOf} = require('../tools/books/storage');
  assert(sizeOf(f.options.directory) <= 300000);
});

test('startup cleanup does not follow a book-directory symlink', t => {
  const f = fixture(t), id = 'a'.repeat(24);
  const outside = path.join(path.dirname(f.options.directory), 'outside');
  fs.mkdirSync(outside); fs.mkdirSync(f.options.directory);
  fs.writeFileSync(path.join(outside, 'job.json'), JSON.stringify({id, state: 'complete', chunks: []}));
  fs.writeFileSync(path.join(outside, 'concat.txt'), 'keep');
  fs.symlinkSync(outside, path.join(f.options.directory, id), 'dir');
  const jobs = createBookJobs(f.options); t.after(() => jobs.close());
  assert.equal(jobs.list().length, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'concat.txt'), 'utf8'), 'keep');
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
