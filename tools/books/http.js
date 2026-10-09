const fs = require('node:fs');
const xml = value => String(value ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readJson(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Book upload is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function serveFile(req, res, file, type, extra = {}) {
  let stat;
  try { stat = fs.statSync(file); if (!stat.isFile()) throw new Error(); }
  catch { res.writeHead(404); res.end('Not found'); return; }
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    let valid = match && (match[1] || match[2]);
    if (valid) {
      if (!match[1]) { valid = Number(match[2]) > 0; start = Math.max(0, stat.size - Number(match[2])); }
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    }
    if (!valid || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
    }
    status = 206;
  }
  const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
function rss(jobs, base, feedToken) {
  const feedUrl = `${base}/feed/${feedToken}.xml`;
  const items = jobs.filter(job => job.state === 'complete').map(job => {
    const url = `${base}/podcast/${feedToken}/${job.id}.mp3`;
    return `<item><title>${xml(job.title)}</title><description>${job.preview ? 'Short preview. ' : ''}Synthetic narration by Kokoro (${xml(job.voice)}).</description><guid isPermaLink="false">sonora-${job.id}</guid><pubDate>${new Date(job.publishedAt).toUTCString()}</pubDate><enclosure url="${xml(url)}" length="${job.length}" type="audio/mpeg"/><itunes:duration>${Math.round(job.duration)}</itunes:duration></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Sonora books</title><description>Private ebooks with synthetic Kokoro narration.</description><language>en-us</language><link>${xml(base)}</link><atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml"/>${items}</channel></rss>`;
}
module.exports = { json, readJson, serveFile, rss };
