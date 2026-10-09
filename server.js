const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createNarrationBackend } = require('./tools/narration/backend');
const voiceConfig = require('./tools/narration/config');
const { extensionOrigin, extensionAccess, localRequest } = require('./tools/narration/extension-access');
const { createBookJobs, atomicJson } = require('./tools/books/jobs');
const { json, readJson, serveFile, rss } = require('./tools/books/http');

const publicRoot = path.resolve(__dirname, 'public');
const runtime = path.resolve(process.env.SONORA_DATA || path.join(__dirname, '.runtime'));
const configFile = path.join(runtime, 'config.json');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
if (!fs.existsSync(configFile)) atomicJson(configFile, {
  studioToken: crypto.randomBytes(32).toString('hex'), feedToken: crypto.randomBytes(24).toString('hex')
});
const credentials = JSON.parse(fs.readFileSync(configFile, 'utf8'));
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function authorized(req) {
  if (extensionOrigin(req)) {
    try { return Boolean(extensionAccess(req, new URL(req.url, 'http://localhost').pathname)); }
    catch { return false; }
  }
  const local = localRequest(req);
  const cookie = /(?:^|;\s*)sonora_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!local && !equal(cookie, credentials.studioToken)) return false;
  const changesState = !['GET', 'HEAD'].includes(req.method);
  if (changesState && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  if (changesState && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}
const narration = createNarrationBackend({ authorize: authorized });
let ffmpeg = process.env.FFMPEG_BIN;
if (!ffmpeg) {
  try { ffmpeg = execFileSync(voiceConfig.python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8', timeout: 15000 }).trim(); }
  catch { ffmpeg = 'ffmpeg'; }
}
const jobs = createBookJobs({ directory: path.join(runtime, 'books'), narration, ffmpeg });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return new URL(process.env.PUBLIC_BASE_URL).origin;
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return new URL(`${protocol}://${req.headers.host}`).origin;
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const extension = extensionAccess(req, pathname);
    if (extension) {
      res.setHeader('Access-Control-Allow-Origin', extension);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, range');
      res.setHeader('Access-Control-Expose-Headers', 'content-length, content-range, accept-ranges');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }
    const studio = /^\/studio\/([a-f0-9]{64})\/$/.exec(pathname);
    if (studio && req.method === 'GET' && equal(studio[1], credentials.studioToken)) {
      const secure = baseUrl(req).startsWith('https:') ? '; Secure' : '';
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': `sonora_session=${credentials.studioToken}; HttpOnly; SameSite=Lax; Path=/${secure}` });
      res.end(); return;
    }
    const feed = /^\/feed\/([a-f0-9]{48})\.xml$/.exec(pathname);
    if (feed && ['GET', 'HEAD'].includes(req.method) && equal(feed[1], credentials.feedToken)) {
      const body = rss(jobs.list(), baseUrl(req), credentials.feedToken);
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body); return;
    }
    const podcast = /^\/podcast\/([a-f0-9]{48})\/([a-f0-9]{24})\.mp3$/.exec(pathname);
    if (podcast && ['GET', 'HEAD'].includes(req.method) && equal(podcast[1], credentials.feedToken) && jobs.get(podcast[2])?.state === 'complete') {
      serveFile(req, res, jobs.audioFile(podcast[2]), 'audio/mpeg'); return;
    }
    if (!authorized(req)) { res.writeHead(404); res.end('Not found'); return; }
    if (await narration.handle(req, res, pathname)) return;
    if (pathname === '/api/feed' && req.method === 'GET') {
      json(res, 200, { feedUrl: `${baseUrl(req)}/feed/${credentials.feedToken}.xml` }); return;
    }
    if (pathname === '/api/books' && req.method === 'GET') { json(res, 200, { jobs: jobs.list() }); return; }
    if (pathname === '/api/books' && req.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'Send book text as JSON.' }); return; }
      json(res, 202, jobs.create(await readJson(req))); return;
    }
    const book = /^\/api\/books\/([a-f0-9]{24})(?:\/(audio|retry))?$/.exec(pathname);
    if (book) {
      const job = jobs.get(book[1]);
      if (!job) { json(res, 404, { error: 'Book job not found.' }); return; }
      if (book[2] === 'audio' && ['GET', 'HEAD'].includes(req.method)) {
        if (job.state !== 'complete') { json(res, 409, { error: 'Audio is still being converted.' }); return; }
        const filename = job.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80) || 'book';
        serveFile(req, res, jobs.audioFile(job.id), 'audio/mpeg', { 'Content-Disposition': `attachment; filename="${filename}.mp3"` }); return;
      }
      if (book[2] === 'retry' && req.method === 'POST') { json(res, 202, jobs.retry(job.id)); return; }
      if (!book[2] && req.method === 'GET') { json(res, 200, job); return; }
      json(res, 405, { error: 'Method not allowed.' }); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const file = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(publicRoot + path.sep)) { res.writeHead(404); res.end('Not found'); return; }
    serveFile(req, res, file, types[path.extname(file)] || 'application/octet-stream');
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    else res.destroy();
  }
});
server.requestTimeout = 120000;
const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => console.log(`Sonora listening at http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  jobs.close(); narration.close(); server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
