// Controlled reader boundary benchmark; uses native HTML audio through Chromium.
// node tools/profile-reader.cjs [baseline revision] [output JSON] [repetitions]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { browser, waitFor } = require('../tests/helpers/browser');

const root = path.resolve(__dirname, '..');
const revision = process.argv[2] || '52e781d';
const destination = path.resolve(process.argv[3] || path.join(root, 'output/reader-audit2/gaps.json'));
const repetitions = Number(process.argv[4] || 3);
if (!Number.isInteger(repetitions) || repetitions < 3) throw new Error('Use at least three interleaved repetitions.');
const sources = {
  before: execFileSync('git', ['show', `${revision}:public/app.js`], {cwd: root, encoding: 'utf8'}),
  after: fs.readFileSync(path.join(root, 'public/app.js'), 'utf8')
};
const fixture = Array.from({length: 110}, (_, i) => `Sentence ${i} is included to cross another chunk boundary.`).join(' ');
const load = () => ({at: new Date().toISOString(), loadavg: os.loadavg(), uptime: execFileSync('uptime', {encoding: 'utf8'}).trim()});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function wav(seconds) {
  const data = Buffer.alloc(44 + Math.round(48000 * seconds));
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let at = 44; at < data.length; at += 2) data.writeInt16LE(Math.round(500 * Math.sin(at / 48000 * 440 * Math.PI * 2)), at);
  return data;
}
function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * fraction;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

(async () => {
  const result = {baseline: revision, fixtureHash: crypto.createHash('sha256').update(fixture).digest('hex'),
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, crypto.createHash('sha256').update(text).digest('hex')])),
    renderDelayMs: 250, audioSeconds: .6, repetitions, runs: [], summary: {}};
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  let condition, requests;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (pathname === '/api/narration/status') return json({ready: true, state: 'ready'});
    if (pathname === '/api/books') return json({jobs: []});
    if (pathname === '/api/narration/render') {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({at: Date.now(), ...JSON.parse(body)});
      await sleep(result.renderDelayMs);
      if (!res.destroyed) json({audioUrl: '/audio.wav', words: []});
      return;
    }
    if (pathname === '/audio.wav') { res.setHeader('Content-Type', 'audio/wav'); res.end(wav(result.audioSeconds)); return; }
    if (pathname === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(sources[condition]); return; }
    const files = {'/': 'index.html', '/text.js': 'text.js', '/app.css': 'app.css', '/favicon.svg': 'favicon.svg'};
    if (!files[pathname]) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(fs.readFileSync(path.join(root, 'public', files[pathname])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (let rep = 0; rep < repetitions; rep++) for (condition of rep % 2 ? ['after', 'before'] : ['before', 'after']) {
      requests = [];
      const cleanup = [], beforeLoad = load();
      try {
        const page = await browser({after(fn) { cleanup.push(fn); }, skip(reason) { throw new Error(reason); }}, '<!doctype html><title>Reader benchmark</title>');
        await page.send('Fetch.disable');
        await page.send('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/`});
        await waitFor(page, `document.querySelector('#engine-chip')?.textContent.includes('local voice ready')`);
        await page.evaluate(`(() => {
          const file = new File([${JSON.stringify(fixture)}], 'boundary-fixture.txt', {type: 'text/plain'});
          const transfer = new DataTransfer(); transfer.items.add(file);
          const input = document.querySelector('#book-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
        })()`);
        await waitFor(page, `document.querySelector('#reader-view')?.hidden === false`);
        await page.evaluate(`window.audioEvents = []; for (const type of ['ended', 'playing']) document.querySelector('#audio').addEventListener(type, () => audioEvents.push({type, at: performance.now()}));`);
        await page.send('Runtime.evaluate', {expression: `document.querySelector('#listen-btn').click()`, userGesture: true});
        await waitFor(page, `document.querySelector('#voice-state').textContent === 'Chapter complete'`, 30000);
        const events = await page.evaluate('audioEvents');
        const gaps = events.filter(event => event.type === 'ended').slice(0, -1).map(event => events.find(next => next.type === 'playing' && next.at > event.at).at - event.at);
        if (gaps.length !== 5 || requests.length !== 6) throw new Error(`Expected six chunks/five gaps, got ${requests.length}/${gaps.length}`);
        if (page.errors.length) throw new Error(page.errors.join('\n'));
        result.runs.push({condition, rep, beforeLoad, afterLoad: load(), events, gaps, median: quantile(gaps, .5), requests});
        console.log(JSON.stringify({condition, rep, gaps, median: quantile(gaps, .5)}));
        fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
      } finally { for (const fn of cleanup.reverse()) await fn(); }
    }
    for (const name of ['before', 'after']) {
      const medians = result.runs.filter(run => run.condition === name).map(run => run.median);
      result.summary[name] = {medianMs: quantile(medians, .5), iqrMs: quantile(medians, .75) - quantile(medians, .25), runMedians: medians};
    }
    fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result.summary));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
