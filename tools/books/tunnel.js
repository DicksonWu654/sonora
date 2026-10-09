const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicJson } = require('./jobs');
const directory = path.resolve(process.env.SONORA_DATA || path.join(__dirname, '../../.runtime'));
const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
const port = process.env.PORT || '8787';
const command = process.env.CLOUDFLARED_BIN || 'cloudflared';
// cloudflared authenticates the studio through its private session URL. No
// inference API or filesystem is exposed to an anonymous tunnel visitor.
const child = spawn(command, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2'], { stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
function output(chunk) {
  const value = chunk.toString();
  process.stderr.write(value);
  tail = (tail + value).slice(-8000);
  const base = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(tail)?.[0];
  if (base) {
    atomicJson(path.join(directory, 'access.json'), { baseUrl: base,
      studioUrl: `${base}/studio/${credentials.studioToken}/`, feedUrl: `${base}/feed/${credentials.feedToken}.xml` });
  }
}
child.stdout.on('data', output); child.stderr.on('data', output);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
